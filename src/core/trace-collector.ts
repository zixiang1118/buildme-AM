import { randomUUID } from "node:crypto";

import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import type { Context as ModelContext } from "@earendil-works/pi-ai";

import { estimateTokens, refreshTraceUsage, updateTraceUsage, type ContextBreakdown, type TraceEvent, type TraceEventInput, type TraceNotification, type TraceTurn } from "./trace.js";
import { redactTrace, traceAttempt, truncateUtf8 } from "./trace-redact.js";
import { capabilityForTool } from "./capabilities.js";
import { traceContextItems } from "./trace-context.js";

export const TRACE_RAW_BYTES = 2 * 1024 * 1024;
export const TRACE_PREVIEW_BYTES = 4 * 1024;
export const TRACE_RESULT_BYTES = 64 * 1024;

export function contextBreakdown(context: ModelContext, limit: number): ContextBreakdown {
	const parts = {
		systemPrompt: estimateTokens(context.systemPrompt ?? ""),
		toolDefinitions: context.tools?.length ? estimateTokens(JSON.stringify(context.tools)) : 0,
		userMessages: 0, assistantMessages: 0, toolResults: 0, summary: 0,
	};
	for (const message of context.messages) {
		let text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		if (message.role === "user") {
			text = text.replace(/<context-summary>[\s\S]*?<\/context-summary>/g, (summary) => {
				parts.summary += estimateTokens(summary);
				return "";
			});
			parts.userMessages += estimateTokens(text);
		} else if (message.role === "assistant") parts.assistantMessages += estimateTokens(text);
		else parts.toolResults += estimateTokens(text);
	}
	return { ...parts, total: Object.values(parts).reduce((sum, count) => sum + count, 0), limit };
}

function fitRaw(raw: unknown, maxBytes: number): { raw: unknown; rawTruncated: boolean } {
	const text = JSON.stringify(raw);
	const data = JSON.parse(text);
	if (Buffer.byteLength(text) <= maxBytes) return { raw: data, rawTruncated: false };
	if (Array.isArray(data?.context?.messages)) {
		for (const message of data.context.messages) {
			message.content = [{ type: "text", text: "[原始内容因记录容量限制已省略]" }];
			if (Buffer.byteLength(JSON.stringify(data)) <= maxBytes) return { raw: data, rawTruncated: true };
		}
	}
	// A bounded JSON preview remains inspectable even for giant tool definitions or images.
	let preview = truncateUtf8(text, maxBytes / 2);
	while (Buffer.byteLength(JSON.stringify({ preview })) > maxBytes) preview = truncateUtf8(preview, Buffer.byteLength(preview) / 2);
	return { raw: { preview }, rawTruncated: true };
}

export function limitTraceRaw(events: readonly TraceEvent[]): void {
	const requests = events.filter((item): item is Extract<TraceEvent, { type: "llm.request" }> => item.type === "llm.request" && item.raw !== undefined);
	let bytes = requests.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.raw)), 0);
	for (const request of requests) {
		if (bytes <= TRACE_RAW_BYTES) break;
		const size = Buffer.byteLength(JSON.stringify(request.raw));
		const allowance = size - (bytes - TRACE_RAW_BYTES);
		if (allowance < 128) delete request.raw;
		else Object.assign(request, fitRaw(request.raw, allowance));
		request.rawTruncated = true;
		bytes -= size - (request.raw === undefined ? 0 : Buffer.byteLength(JSON.stringify(request.raw)));
	}
}

export class TraceCollector {
	readonly id = randomUUID();
	private turn: TraceTurn | undefined;
	private round = 0;
	private parallelGroup: number | undefined;
	private readonly toolsStarted = new Map<string, number>();
	private readonly approvals = new Set<string>();

	constructor(
		private readonly publish: (notification: TraceNotification) => void,
		private readonly secrets: readonly (string | undefined)[],
		private readonly recordRaw = true,
	) {}

	beginTurn(input: Omit<TraceTurn, "id" | "startedAt" | "status" | "events" | "usage">): void {
		this.turn = redactTrace({
			...input, id: this.id, startedAt: new Date().toISOString(), status: "running",
			events: [], usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 },
		}, this.secrets);
		traceAttempt(() => this.publish({ type: "turn-start", turn: structuredClone(this.turn!) }));
	}

	event(input: TraceEventInput): void {
		if (!this.turn) return;
		const event = redactTrace({ ...input, id: randomUUID(), at: new Date().toISOString() }, this.secrets);
		if (event.type === "subagent.end") event.resultPreview = truncateUtf8(event.resultPreview, TRACE_PREVIEW_BYTES);
		if (event.type === "context.compacted") event.summaryPreview = truncateUtf8(event.summaryPreview, TRACE_PREVIEW_BYTES);
		updateTraceUsage(this.turn.usage, event);
		if (event.type === "llm.request") {
			if (!this.recordRaw) delete event.raw;
			if (event.raw !== undefined) {
				Object.assign(event, fitRaw(event.raw, TRACE_RAW_BYTES));
				limitTraceRaw([...this.turn.events, event]);
			}
		} else if (event.type === "tool.approval") this.approvals.add(event.toolCallId);
		this.turn.events.push(event);
		traceAttempt(() => this.publish({ type: "event", turnId: this.turn!.id, event: structuredClone(event) }));
	}

	wrapStream(stream: StreamFn, limit: number): StreamFn {
		return (model, context, options) => {
			const round = ++this.round;
			const started = performance.now();
			traceAttempt(() => this.event({
				type: "llm.request", round, messageCount: context.messages.length,
				toolNames: (context.tools ?? []).map((tool) => tool.name), context: contextBreakdown(context, limit),
				contextItems: traceContextItems(context.messages.map((message) => message.role === "toolResult"
					? { kind: "tool", content: message.content, toolCallId: message.toolCallId, toolName: message.toolName }
					: { kind: message.role, content: message.content })),
				...(this.recordRaw ? { raw: { format: "pi-context", model: { provider: model.provider, id: model.id }, context, options } } : {}),
			}));
			const observe = (responseStream: Awaited<ReturnType<StreamFn>>) => {
				traceAttempt(() => {
					void responseStream.result().then((response) => {
						const missingUsage = ["aborted", "error"].includes(response.stopReason)
							&& response.usage.input + response.usage.output + response.usage.cacheRead + response.usage.cacheWrite === 0;
						const thinking = response.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("\n");
						const reasoning = truncateUtf8(redactTrace(thinking, this.secrets), TRACE_RESULT_BYTES);
						traceAttempt(() => this.event({
							type: "llm.response", round, durationMs: Math.round(performance.now() - started),
							...(reasoning ? { reasoning, reasoningTruncated: Buffer.byteLength(thinking) > TRACE_RESULT_BYTES } : {}),
							stopReason: response.stopReason,
							...(missingUsage ? {} : { usage: { input: response.usage.input, output: response.usage.output, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite } }),
							textPreview: truncateUtf8(redactTrace(response.content.filter((block) => block.type === "text").map((block) => block.text).join(""), this.secrets), TRACE_PREVIEW_BYTES),
							toolCalls: response.content.filter((block) => block.type === "toolCall").map((block) => ({ toolCallId: block.id, name: block.name })),
						}));
					}, () => console.warn("[X 光] 模型响应记录失败。"));
				});
				return responseStream;
			};
			const result = stream(model, context, options);
			return result instanceof Promise ? result.then(observe) : observe(result);
		};
	}

	onAgentEvent(event: AgentEvent, permissionMode: string, parallel: boolean, sequentialTools: readonly string[]): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const calls = event.message.content.filter((block) => block.type === "toolCall");
			this.parallelGroup = parallel && calls.length > 1 && !calls.some((call) => sequentialTools.includes(call.name)) ? this.round : undefined;
		} else if (event.type === "tool_execution_start") {
			this.toolsStarted.set(event.toolCallId, performance.now());
			const capabilityId = capabilityForTool(event.toolName);
			this.event({
				type: "tool.call", round: this.round, toolCallId: event.toolCallId, name: event.toolName, args: event.args,
				...(capabilityId === undefined ? {} : { capabilityId }),
				...(this.parallelGroup === undefined ? {} : { parallelGroup: this.parallelGroup }),
			});
		} else if (event.type === "tool_execution_end") {
			const result = JSON.stringify(redactTrace(event.result, this.secrets));
			if (!this.approvals.has(event.toolCallId)) {
				this.event({ type: "tool.approval", toolCallId: event.toolCallId, permissionMode, decision: "policy-deny", reason: "Pi 在进入权限审批前终止了工具调用（例如参数无效、工具不存在或请求已取消）。" });
			}
			this.event({
				type: "tool.result", toolCallId: event.toolCallId,
				durationMs: Math.round(performance.now() - this.toolsStarted.get(event.toolCallId)!),
				isError: event.isError, resultPreview: truncateUtf8(result, TRACE_PREVIEW_BYTES),
				result: truncateUtf8(result, TRACE_RESULT_BYTES), resultBytes: Buffer.byteLength(result),
				truncated: Buffer.byteLength(result) > TRACE_RESULT_BYTES,
			});
			this.toolsStarted.delete(event.toolCallId);
		}
	}

	endTurn(status: Exclude<TraceTurn["status"], "running">, errorMessage?: string, finalAnswer?: string): void {
		if (!this.turn) return;
		this.turn.status = status;
		this.turn.endedAt = new Date().toISOString();
		this.turn.usage.durationMs = Date.parse(this.turn.endedAt) - Date.parse(this.turn.startedAt);
		refreshTraceUsage(this.turn);
		if (errorMessage !== undefined) this.turn.errorMessage = errorMessage;
		if (finalAnswer !== undefined) this.turn.finalAnswer = finalAnswer;
		const turn = redactTrace(this.turn, this.secrets);
		this.turn = undefined;
		traceAttempt(() => this.publish({ type: "turn-end", turn }));
	}
}
