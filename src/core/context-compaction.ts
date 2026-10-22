import { estimateTokens, serializeConversation, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { traceAttempt } from "./trace-redact.js";

/**
 * Keeps a Pi run inside the model's context window. It runs as Pi's
 * `transformContext` hook before every model call and works in two stages:
 *
 * 1. Clip: large tool results (a PDF chapter, a web page) older than the recent
 *    window are shortened to a head/tail excerpt. Cheap, no model call.
 * 2. Summarize: if the context is still over budget, everything before a safe
 *    cut point is replaced by a model-written summary. The summary is
 *    persisted, so later runs of the session start from it instead of
 *    replaying (and re-summarizing) the whole history.
 *
 * The durable JSONL log is never rewritten; compaction only changes what is
 * sent to the model.
 */

export interface CompactionState {
	readonly summary: string;
	/** Number of leading session messages the summary replaces. */
	readonly coveredMessages: number;
}

export interface ContextCompactorOptions {
	readonly model: Model<Api>;
	readonly stream: StreamFn;
	/** Summary loaded from the session, if one exists. */
	readonly initial?: CompactionState | undefined;
	/** Persists a new summary; awaited before the model call continues. */
	readonly onCompacted?: (state: CompactionState & { readonly tokensBefore: number }) => Promise<void>;
	readonly onClipped?: (clip: { toolCallId: string; charsBefore: number; charsAfter: number }) => void;
	readonly contextWindow?: number;
	readonly reserveTokens?: number;
	readonly keepRecentTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const CLIP_THRESHOLD_CHARS = 6_000;
const CLIP_HEAD_CHARS = 2_000;
const CLIP_TAIL_CHARS = 500;
const SUMMARY_MARKER = "<context-summary>";

const SUMMARY_SYSTEM_PROMPT =
	"你是对话摘要助手。你的任务是阅读用户与 AI 助手之间的对话，写出结构化摘要，供助手在上下文被截断后继续工作。" +
	"不要继续对话，不要回答对话中的问题，只输出摘要。";

const SUMMARY_INSTRUCTIONS = `请为上面的对话写一份结构化摘要，助手之后只能看到这份摘要和最近的几条消息。使用对话所用的语言，按下列标题组织，没有内容的部分写"无"：

## 用户目标
用户要完成的任务，以及项目背景、约束和要求。

## 已完成的工作
按时间顺序列出已经完成的步骤和结论。

## 已读资料与关键信息
每份读过的文件或网页：名称/路径/URL，以及从中获得的关键信息。原样保留名称、版本号、路径、行号、页码和数据，不要改写数字，不要补充对话中没有出现的信息。

## 已做出的决定与用户偏好
用户确认过的方案、风格要求、明确拒绝过的做法。

## 修改过的文件
创建或修改过的文件路径及改动内容概要。

## 待办与下一步
尚未完成的事项，以及对话结束时正在进行的工作。

## 未解决的问题
需要用户决定、核实或补充的内容。`;

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "")).join("");
}

function totalTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function clipToolResult(message: ToolResultMessage, onClipped: ContextCompactorOptions["onClipped"]): ToolResultMessage {
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type === "image") {
			changed = true;
			return { type: "text" as const, text: "[较早的图片已从上下文中省略]" };
		}
		if (block.text.length <= CLIP_THRESHOLD_CHARS) return block;
		changed = true;
		const omitted = block.text.length - CLIP_HEAD_CHARS - CLIP_TAIL_CHARS;
		return {
			...block,
			text: `${block.text.slice(0, CLIP_HEAD_CHARS)}\n\n…[为节省上下文，已省略 ${omitted} 字符；需要时请重新读取原文]…\n\n${block.text.slice(-CLIP_TAIL_CHARS)}`,
		};
	});
	if (!changed) return message;
	traceAttempt(() => onClipped?.({
		toolCallId: message.toolCallId,
		charsBefore: message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : block.data.length), 0),
		charsAfter: content.reduce((sum, block) => sum + block.text.length, 0),
	}));
	return { ...message, content };
}

/** Clip tool results in `messages[0, until)`; later messages are left intact. */
function clipOlderToolResults(messages: readonly AgentMessage[], until: number, onClipped: ContextCompactorOptions["onClipped"]): AgentMessage[] {
	return messages.map((message, index) =>
		index < until && message.role === "toolResult" ? clipToolResult(message as ToolResultMessage, onClipped) : message,
	);
}

/** Index of the first message inside the most recent `keepTokens` worth of context. */
function recentWindowStart(messages: readonly AgentMessage[], keepTokens: number): number {
	let accumulated = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		accumulated += estimateTokens(messages[index]!);
		if (accumulated >= keepTokens) return index;
	}
	return 0;
}

/**
 * A cut must not separate a tool result from the assistant message that called
 * it, so the kept tail starts at a user or assistant message.
 */
function safeCutPoint(messages: readonly AgentMessage[], keepTokens: number): number {
	const start = recentWindowStart(messages, keepTokens);
	for (let index = Math.max(start, 1); index < messages.length; index += 1) {
		if (messages[index]!.role !== "toolResult") return index;
	}
	for (let index = Math.min(start, messages.length - 1); index > 0; index -= 1) {
		if (messages[index]!.role !== "toolResult") return index;
	}
	return 0;
}

function summaryText(summary: string): string {
	return `${SUMMARY_MARKER}\n以下是本会话较早部分的摘要（原始消息已不在上下文中）：\n\n${summary}\n</context-summary>`;
}

/** Prepend the summary; merge it into a leading user message to keep roles alternating. */
function withSummary(summary: string, tail: readonly AgentMessage[]): AgentMessage[] {
	const first = tail[0];
	if (first?.role === "user") {
		const user = first as UserMessage;
		const content = typeof user.content === "string" ? [{ type: "text" as const, text: user.content }] : user.content;
		return [{ ...user, content: [{ type: "text", text: summaryText(summary) }, ...content] }, ...tail.slice(1)];
	}
	const summaryMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: summaryText(summary) }],
		timestamp: Date.now(),
	};
	return [summaryMessage, ...tail];
}

export class ContextCompactor {
	private state: CompactionState | undefined;
	private readonly contextWindow: number;
	private readonly reserveTokens: number;
	private readonly keepRecentTokens: number;

	constructor(private readonly options: ContextCompactorOptions) {
		this.state = options.initial;
		this.contextWindow = options.contextWindow ?? (options.model.contextWindow > 0 ? options.model.contextWindow : DEFAULT_CONTEXT_WINDOW);
		this.reserveTokens = options.reserveTokens ?? Math.min(16_384, Math.floor(this.contextWindow * 0.2));
		this.keepRecentTokens = options.keepRecentTokens ?? Math.min(20_000, Math.floor(this.contextWindow * 0.25));
	}

	/** Token budget for everything sent to the model, excluding the reply reserve. */
	get budget(): number {
		return this.contextWindow - this.reserveTokens;
	}

	get current(): CompactionState | undefined {
		return this.state;
	}

	/** Pi `transformContext` hook. `messages` is the full session history of this run. */
	async transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const covered = this.state && this.state.coveredMessages <= messages.length ? this.state.coveredMessages : 0;
		const summary = covered > 0 ? this.state!.summary : undefined;
		const live = messages.slice(covered);

		const clipped = clipOlderToolResults(live, recentWindowStart(live, this.keepRecentTokens), this.options.onClipped);
		const assembled = summary === undefined ? clipped : withSummary(summary, clipped);
		const tokensBefore = totalTokens(assembled);
		if (tokensBefore <= this.budget) return assembled;

		const cut = safeCutPoint(live, this.keepRecentTokens);
		if (cut <= 0) return this.clipEverything(assembled);

		let nextSummary: string;
		try {
			nextSummary = await this.summarize(clipped.slice(0, cut), summary, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			// A failed summary must not kill the run: drop the oldest part instead
			// and keep whatever summary already existed.
			const tail = clipped.slice(cut);
			const note = `${summary ?? ""}\n\n（更早的 ${cut} 条消息因摘要失败而被省略：${error instanceof Error ? error.message : String(error)}）`.trim();
			return this.clipEverything(withSummary(note, tail));
		}

		this.state = { summary: nextSummary, coveredMessages: covered + cut };
		await this.options.onCompacted?.({ ...this.state, tokensBefore });
		const result = withSummary(nextSummary, clipped.slice(cut));
		return totalTokens(result) <= this.budget ? result : this.clipEverything(result);
	}

	/** Last resort: clip every tool result except the most recent message. */
	private clipEverything(messages: AgentMessage[]): AgentMessage[] {
		return clipOlderToolResults(messages, messages.length - 1, this.options.onClipped);
	}

	private async summarize(messages: readonly AgentMessage[], previousSummary: string | undefined, signal?: AbortSignal): Promise<string> {
		const llmMessages = messages.filter((message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		).map((message) =>
			// A summary merged into a user message is itself summarized as "previous summary".
			message.role === "user" && textOf(message).startsWith(SUMMARY_MARKER)
				? { ...message, content: textOf(message).slice(textOf(message).indexOf("</context-summary>") + "</context-summary>".length) || " " }
				: message,
		);
		// Keep the summarization request itself inside the window.
		const maxInputChars = Math.max(20_000, (this.budget - this.reserveTokens) * 3);
		let conversation = serializeConversation(llmMessages);
		if (conversation.length > maxInputChars) {
			// Keep the opening (task, topic, requirements) and the most recent part.
			const head = Math.floor(maxInputChars * 0.3);
			conversation = `${conversation.slice(0, head)}\n\n…[中间部分过长，已省略]…\n\n${conversation.slice(-(maxInputChars - head))}`;
		}
		const prompt = [
			`<conversation>\n${conversation}\n</conversation>`,
			...(previousSummary ? [`<previous-summary>\n${previousSummary}\n</previous-summary>\n\n请把上面的新对话合并进之前的摘要，输出一份完整的新摘要。`] : []),
			SUMMARY_INSTRUCTIONS,
		].join("\n\n");

		const stream = await this.options.stream(
			this.options.model,
			{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ maxTokens: Math.min(Math.floor(this.reserveTokens * 0.8), this.options.model.maxTokens > 0 ? this.options.model.maxTokens : 8_192), ...(signal ? { signal } : {}) },
		);
		const response = await stream.result();
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage || `summary request ${response.stopReason}`);
		}
		const text = textOf(response).trim();
		if (!text) throw new Error("summary was empty");
		return text;
	}
}
