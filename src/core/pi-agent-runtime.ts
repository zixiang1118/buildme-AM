import { createHash } from "node:crypto";

import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { Service, type Context } from "@deepseek-ai/cordis";

import type { AgentConnection, AgentEdition, AgentPermissionMode } from "../contracts.js";
import type {
	AgentFactory,
	AgentHandle,
	CreateAgentOptions,
	HarnessAgent,
	HarnessAgentStatus,
	ResumeAgentOptions,
} from "./agent-registry.js";
import { redactDurable, redactError } from "./redact.js";
import { ContextCompactor } from "./context-compaction.js";
import type { SessionLease } from "./session-store.js";
import { contextBreakdown, TraceCollector } from "./trace-collector.js";
import { resolveCapabilities } from "./capabilities.js";
import { estimateTokens } from "./trace.js";
import { traceAttempt } from "./trace-redact.js";
import { parseChatImages } from "./chat-images.js";

export interface AgentRunOptions {
	readonly images?: readonly ImageContent[];
	readonly sessionId?: string;
	readonly connection?: AgentConnection;
	readonly workspacePath?: string;
	readonly compareGroupId?: string;
	readonly comparePolicy?: import("./compare-policy.js").ComparePolicy;
	readonly permissionMode?: AgentPermissionMode;
	readonly edition?: AgentEdition;
	readonly recordRawRequests?: boolean;
	readonly capabilities?: readonly string[];
	readonly signal?: AbortSignal;
	readonly parentTrace?: {
		readonly collector: TraceCollector;
		readonly kind: "delegate_task" | "workflow_run";
		readonly toolCallId: string;
		readonly stepIndex?: number;
	};
}

export interface AgentRunResult {
	readonly sessionId: string;
	readonly model: {
		readonly provider: string;
		readonly id: string;
	};
	readonly text: string;
	readonly messageCount: number;
}

function isPersistableMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function assistantText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return (message as AssistantMessage).content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * Pi uses explicit `undefined` for some optional protocol fields. JSONL has a
 * stricter contract: optional protocol fields are omitted, while arbitrary
 * tool arguments/details remain untouched and are validated by the store.
 */
function durableUsage(usage: AssistantMessage["usage"]): Record<string, unknown> {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
		...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
		...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
	};
}

function durableContent(content: UserMessage["content"] | ToolResultMessage["content"]): unknown {
	if (typeof content === "string") return content;
	return content.map((block) => {
		if (block.type === "text") {
			return { type: "text", text: block.text, ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) };
		}
		return { type: "image", data: block.data, mimeType: block.mimeType };
	});
}

function durableAssistantContent(content: AssistantMessage["content"]): unknown {
	return content.map((block) => {
		if (block.type === "text") {
			return { type: "text", text: block.text, ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }) };
		}
		if (block.type === "thinking") {
			return {
				type: "thinking",
				thinking: block.thinking,
				...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
				...(block.redacted === undefined ? {} : { redacted: block.redacted }),
			};
		}
		return {
			type: "toolCall",
			id: block.id,
			name: block.name,
			arguments: block.arguments,
			...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
			...(block.namespace === undefined ? {} : { namespace: block.namespace }),
		};
	});
}

function durableDiagnostics(diagnostics: NonNullable<AssistantMessage["diagnostics"]>): unknown {
	return diagnostics.map((diagnostic) => ({
		type: diagnostic.type,
		timestamp: diagnostic.timestamp,
		...(diagnostic.error === undefined
			? {}
			: {
					error: {
						message: diagnostic.error.message,
						...(diagnostic.error.name === undefined ? {} : { name: diagnostic.error.name }),
						...(diagnostic.error.stack === undefined ? {} : { stack: diagnostic.error.stack }),
						...(diagnostic.error.code === undefined ? {} : { code: diagnostic.error.code }),
					},
				}),
		...(diagnostic.details === undefined ? {} : { details: diagnostic.details }),
	}));
}

function durableMessage(message: Message): unknown {
	if (message.role === "user") {
		return { role: "user", content: durableContent(message.content), timestamp: message.timestamp };
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: durableContent(message.content),
			isError: message.isError,
			timestamp: message.timestamp,
			...(message.details === undefined ? {} : { details: message.details }),
			...(message.usage === undefined ? {} : { usage: durableUsage(message.usage) }),
			...(message.addedToolNames === undefined ? {} : { addedToolNames: message.addedToolNames }),
		};
	}
	return {
		role: "assistant",
		content: durableAssistantContent(message.content),
		api: message.api,
		provider: message.provider,
		model: message.model,
		usage: durableUsage(message.usage),
		stopReason: message.stopReason,
		timestamp: message.timestamp,
		...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
		...(message.responseId === undefined ? {} : { responseId: message.responseId }),
		...(message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel }),
		...(message.diagnostics === undefined ? {} : { diagnostics: durableDiagnostics(message.diagnostics) }),
		...(message.deferred === undefined
			? {}
			: {
					deferred: {
						provider: message.deferred.provider,
						modelId: message.deferred.modelId,
						api: message.deferred.api,
						id: message.deferred.id,
						...(message.deferred.expiresAt === undefined ? {} : { expiresAt: message.deferred.expiresAt }),
						...(message.deferred.pollAfterMs === undefined ? {} : { pollAfterMs: message.deferred.pollAfterMs }),
						...(message.deferred.data === undefined ? {} : { data: message.deferred.data }),
					},
				}),
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
		...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Pi Agent Core implementation of DSH's replaceable AgentFactory seam. */
export class PiAgentLoop extends Service implements AgentFactory {
	private readonly active = new Map<string, Agent>();
	private readonly abortRequested = new Set<string>();
	private readonly pending = new Set<Promise<AgentRunResult>>();
	private readonly pendingSessions = new Set<string>();
	private readonly factoryOperations = new Set<Promise<AgentHandle>>();
	private readonly handles = new Set<AgentHandle>();
	private shutdownPromise: Promise<void> | undefined;
	private closed = false;

	constructor(ctx: import("@deepseek-ai/cordis").Context) {
		super(ctx, "agentLoop");
	}

	createAgent(_ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
		return this.trackFactoryOperation(this.createAgentInternal(options));
	}

	private async createAgentInternal(options: CreateAgentOptions): Promise<AgentHandle> {
		this.assertFactoryActive();
		if (await this.ctx.sessions.exists(options.sessionId)) {
			throw new Error(`Session already exists: ${options.sessionId}`);
		}
		await this.ctx.sessions.create(options.sessionId);
		this.assertFactoryActive();
		return this.createHandle(options.sessionId);
	}

	resume(_ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
		return this.trackFactoryOperation(this.resumeInternal(options));
	}

	private async resumeInternal(options: ResumeAgentOptions): Promise<AgentHandle> {
		this.assertFactoryActive();
		if (!(await this.ctx.sessions.exists(options.resumeSessionId))) {
			throw new Error(`Unknown session: ${options.resumeSessionId}`);
		}
		this.assertFactoryActive();
		return this.createHandle(options.resumeSessionId);
	}

	isRunning(sessionId: string): boolean {
		return this.active.has(sessionId);
	}

	abort(sessionId: string): boolean {
		const agent = this.active.get(sessionId);
		if (!agent && !this.pendingSessions.has(sessionId)) return false;
		this.abortRequested.add(sessionId);
		agent?.abort();
		return true;
	}

	/** Stop all foreground runs before dependencies such as tools/models/sessions unload. */
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closed = true;
		for (const sessionId of this.pendingSessions) this.abortRequested.add(sessionId);
		for (const [sessionId, agent] of this.active) {
			this.abortRequested.add(sessionId);
			agent.abort();
		}
		this.shutdownPromise = (async () => {
			await Promise.allSettled([...this.factoryOperations]);
			await Promise.allSettled([...this.handles].map((handle) => handle.dispose()));
			await Promise.allSettled([...this.pending]);
		})();
		return this.shutdownPromise;
	}

	run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
		if (options.comparePolicy) options = { ...options, comparePolicy: Object.freeze({ ...options.comparePolicy }) };
		if (options.capabilities !== undefined) options = { ...options, capabilities: resolveCapabilities(options.capabilities) };
		if (this.closed) return Promise.reject(new Error("Agent runtime is shutting down."));
		if (options.sessionId && this.pendingSessions.has(options.sessionId)) {
			return Promise.reject(new Error(`Session ${options.sessionId} already has an active run.`));
		}
		if (options.sessionId) this.pendingSessions.add(options.sessionId);
		const operation = this.runInternal(prompt, options);
		this.pending.add(operation);
		operation.then(
			() => {
				this.pending.delete(operation);
				if (options.sessionId) {
					this.pendingSessions.delete(options.sessionId);
					this.abortRequested.delete(options.sessionId);
				}
			},
			() => {
				this.pending.delete(operation);
				if (options.sessionId) {
					this.pendingSessions.delete(options.sessionId);
					this.abortRequested.delete(options.sessionId);
				}
			},
		);
		return operation;
	}

	private async runInternal(prompt: string, options: AgentRunOptions): Promise<AgentRunResult> {
		if (prompt.trim().length === 0) throw new Error("Prompt cannot be empty.");
		const images = parseChatImages(options.images);
		const sessionId = options.sessionId ?? (await this.ctx.sessions.create());
		if (this.closed) throw new Error("Agent runtime is shutting down.");
		if (options.sessionId && !(await this.ctx.sessions.exists(sessionId))) {
			throw new Error(`Unknown session: ${sessionId}`);
		}
		if (this.active.has(sessionId)) throw new Error(`Session ${sessionId} already has an active run.`);

		const lease = await this.ctx.sessions.acquire(sessionId);
		let unsubscribe: (() => void) | undefined;
		let requestApiKey = options.connection?.apiKey;
		let trace: TraceCollector | undefined;
		const parent = options.parentTrace;
		const started = performance.now();
		let childResult = "";
		let childFailed = true;
		const onAbort = () => this.abort(sessionId);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			options.signal?.throwIfAborted();
			this.assertRunMayStart(sessionId);
			const settings = this.ctx.settings.value.agent;
			const configuredApiKey = settings.apiKeyEnv === undefined ? undefined : (process.env[settings.apiKeyEnv] || undefined);
			const connection: AgentConnection = options.connection ?? {
				provider: settings.provider,
				model: settings.model,
				...(settings.baseUrl === undefined ? {} : { baseUrl: settings.baseUrl }),
				...(configuredApiKey === undefined ? {} : { apiKey: configuredApiKey }),
			};
			requestApiKey = connection.apiKey;
			const resolved = this.ctx.llm.resolveConnection(connection);
			const model = resolved.model;
			if (images.length && !model.input.includes("image")) throw new Error("当前模型不支持图片识别，请选择支持视觉的模型后重试。");
			const [previousMessages, compaction] = await Promise.all([
				this.ctx.sessions.readMessages(sessionId),
				this.ctx.sessions.readCompaction(sessionId),
			]);
			const sections = this.ctx.systemPrompt.renderSections(options.capabilities);
			const systemPrompt = sections.map((section) => section.text).join("\n\n") || settings.systemPrompt;
			trace = traceAttempt(() => new TraceCollector((notification) => this.ctx.emit("piharness/trace", notification), [requestApiKey], options.recordRawRequests));
			traceAttempt(() => {
				if (parent && trace) parent.collector.event({
					type: "subagent.start", childTurnId: trace.id, kind: parent.kind, task: prompt, toolCallId: parent.toolCallId,
					...(parent.stepIndex === undefined ? {} : { stepIndex: parent.stepIndex }),
				});
			});
			traceAttempt(() => trace?.beginTurn({
				...(options.compareGroupId ? { compareGroupId: options.compareGroupId } : {}),
				engine: "pi", sessionId, turnIndex: previousMessages.filter((message) => message.role === "user").length + 1,
				...(parent ? { parentTurnId: parent.collector.id, parentToolCallId: parent.toolCallId } : {}),
				...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
				userPrompt: prompt, model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow },
				fidelity: { promptSegments: true, rawRequest: options.recordRawRequests !== false, usage: "exact", subagents: true, compaction: true, approvals: true },
				promptSegments: (sections.length ? sections : [{ name: "base:settings", text: systemPrompt, source: "base" as const }]).map((section) => ({
					name: section.name, source: section.source ?? "other", text: section.text, chars: section.text.length, estTokens: estimateTokens(section.text),
					...("sourcePath" in section && section.sourcePath ? { sourcePath: section.sourcePath } : {}),
					...("capabilityId" in section && section.capabilityId ? { capabilityId: section.capabilityId } : {}),
				})),
			}));
			const contextWindow = model.contextWindow > 0 ? model.contextWindow : 128_000;
			const contextLimit = contextWindow - Math.min(16_384, Math.floor(contextWindow * 0.2));
			const observedStream = traceAttempt(() => trace?.wrapStream(resolved.stream, contextLimit)) ?? resolved.stream;
			const compact = options.capabilities === undefined || options.capabilities.includes("compaction");
			const traceStream: StreamFn = (model, context, streamOptions) => {
				if (!compact) traceAttempt(() => {
					const usage = contextBreakdown(context, contextLimit);
					if (usage.total > contextLimit) trace?.event({ type: "context.overflow", estTokens: usage.total, limit: contextLimit });
				});
				return observedStream(model, context, streamOptions);
			};
			const compactor = compact ? new ContextCompactor({
				model,
				stream: traceStream,
				initial: compaction,
				onClipped: (clip) => traceAttempt(() => trace?.event({ type: "context.clipped", ...clip })),
				onCompacted: async ({ summary, coveredMessages, tokensBefore }) => {
					traceAttempt(() => trace?.event({ type: "context.compacted", tokensBefore, coveredMessages, summaryPreview: summary }));
					await lease.append("context/compacted", {
						summary: redactDurable(summary, [requestApiKey]) as string,
						coveredMessages,
						tokensBefore,
					});
				},
			}) : undefined;
			const workspacePath = options.workspacePath ?? process.cwd();
			const permissionMode = options.permissionMode ?? "ask";
			const edition = options.edition ?? "standard";
			const tools = [...this.ctx.tools.list({
				workspacePath, permissionMode, edition, connection,
				...(options.comparePolicy ? { comparePolicy: options.comparePolicy } : {}),
				...(options.compareGroupId ? { compareGroupId: options.compareGroupId } : {}),
				...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
				recordRawRequests: options.recordRawRequests !== false,
				...(trace ? { trace } : {}),
			})];
			const agent = new Agent({
				initialState: {
					systemPrompt,
					model,
					messages: previousMessages,
					tools,
					thinkingLevel: settings.thinkingLevel ?? "off",
				},
				streamFn: traceStream,
				transformContext: (messages, signal) => compactor ? compactor.transform(messages, signal) : Promise.resolve(messages),
				sessionId,
				toolExecution: settings.toolExecution ?? "parallel",
				beforeToolCall: async ({ toolCall, args }, signal) => {
					const decision = await this.ctx.tools.authorize(
						{
							sessionId,
							...(trace ? { turnId: trace.id } : {}),
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: redactDurable(args, [requestApiKey]),
							workspacePath,
							...(options.comparePolicy ? { comparePolicy: options.comparePolicy } : {}),
							permissionMode,
						},
						signal,
					);
					traceAttempt(() => trace?.event({
						type: "tool.approval", toolCallId: toolCall.id, permissionMode,
						decision: decision.allow ? (decision.source === "user" ? "user-allow" : "auto-allow") : (decision.source === "cancelled" || decision.source === "timeout" ? decision.source : decision.source === "user" ? "user-deny" : "policy-deny"),
						...(!decision.allow ? { reason: decision.reason } : {}),
					}));
					if (decision.allow) return undefined;
					return {
						block: true,
						reason: decision.reason,
						...(decision.terminate === undefined ? {} : { terminate: decision.terminate }),
					};
				},
			});

			this.assertRunMayStart(sessionId);
			this.active.set(sessionId, agent);
			unsubscribe = agent.subscribe(async (event) => {
				traceAttempt(() => trace?.onAgentEvent(event, permissionMode, settings.toolExecution !== "sequential", tools.filter((tool) => tool.executionMode === "sequential").map((tool) => tool.name)));
				await this.onAgentEvent(lease, event, requestApiKey);
			});
			await lease.append("run/started", {
				provider: model.provider,
				model: model.id,
				toolNames: tools.map((tool) => tool.name),
				systemPromptSha256: sha256(systemPrompt),
				thinkingLevel: settings.thinkingLevel ?? "off",
				toolExecution: settings.toolExecution ?? "parallel",
			});
			this.assertRunMayStart(sessionId);
			await agent.prompt(prompt, images.length ? images : undefined);
			if (agent.state.errorMessage) {
				throw new Error(agent.state.errorMessage);
			}
			const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
			const result: AgentRunResult = {
				sessionId,
				model: { provider: model.provider, id: model.id },
				text: redactDurable(assistantText(lastAssistant), [requestApiKey]) as string,
				messageCount: agent.state.messages.length,
			};
			await lease.append("run/finished", {
				messageCount: result.messageCount,
				error: agent.state.errorMessage ?? null,
			});
			this.ctx.emit("piharness/run-completed", result);
			traceAttempt(() => trace?.endTurn("done", undefined, result.text));
			childResult = result.text;
			childFailed = false;
			return result;
		} catch (error) {
			const exposed = redactError(error, [requestApiKey]);
			childResult = exposed.message;
			traceAttempt(() => trace?.event({ type: "error", message: exposed.message }));
			traceAttempt(() => trace?.endTurn(this.abortRequested.has(sessionId) || options.signal?.aborted ? "aborted" : "error", exposed.message));
			await lease.append("agent/error", {
				message: exposed.message,
			});
			throw exposed;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			traceAttempt(() => {
				if (parent && trace) parent.collector.event({
					type: "subagent.end", childTurnId: trace.id, toolCallId: parent.toolCallId,
					durationMs: Math.round(performance.now() - started), resultPreview: childResult, isError: childFailed,
				});
			});
			unsubscribe?.();
			this.active.delete(sessionId);
			this.abortRequested.delete(sessionId);
			await lease.release();
		}
	}

	private async onAgentEvent(lease: SessionLease, event: AgentEvent, requestApiKey?: string): Promise<void> {
		const { sessionId } = lease;
		switch (event.type) {
			case "message_end":
				if (isPersistableMessage(event.message)) {
					await lease.append(this.messageEventType(event.message), {
						message: redactDurable(durableMessage(event.message), [requestApiKey]),
					});
				}
				break;
			case "tool_execution_start":
				await lease.append("tool/call", {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: redactDurable(event.args, [requestApiKey]),
				});
				break;
			case "tool_execution_end":
				// Tool-result messages are the durable source of truth; this is live only.
				break;
			default:
				break;
		}
		this.ctx.emit("piharness/agent-event", sessionId, redactDurable(event, [requestApiKey]) as AgentEvent);
	}

	private assertRunMayStart(sessionId: string): void {
		if (this.closed) throw new Error("Agent runtime is shutting down.");
		if (this.abortRequested.has(sessionId)) throw new Error("Agent run aborted.");
	}

	private assertFactoryActive(): void {
		if (this.closed) throw new Error("Agent factory is shutting down.");
	}

	private trackFactoryOperation(operation: Promise<AgentHandle>): Promise<AgentHandle> {
		this.factoryOperations.add(operation);
		operation.then(
			() => this.factoryOperations.delete(operation),
			() => this.factoryOperations.delete(operation),
		);
		return operation;
	}

	private messageEventType(message: Message): "user/message" | "assistant/message" | "tool/result" {
		switch (message.role) {
			case "user":
				return "user/message";
			case "assistant":
				return "assistant/message";
			case "toolResult":
				return "tool/result";
		}
	}

	private createHandle(sessionId: string): AgentHandle {
		let status: HarnessAgentStatus = "idle";
		let current: Promise<AgentRunResult> | undefined;
		const agent: HarnessAgent = {
			id: sessionId,
			get status() {
				return status;
			},
			send: (prompt, options = {}) => {
				if (status === "disposed") return Promise.reject(new Error(`Agent ${sessionId} is disposed.`));
				if (status === "busy") return Promise.reject(new Error(`Agent ${sessionId} is already busy.`));
				status = "busy";
				const operation = this.run(prompt, { sessionId, ...options });
				current = operation;
				operation.then(
					() => {
						if (status !== "disposed") status = "idle";
						if (current === operation) current = undefined;
					},
					() => {
						if (status !== "disposed") status = "idle";
						if (current === operation) current = undefined;
					},
				);
				return operation;
			},
			cancel: () => status === "busy" && this.abort(sessionId),
			whenIdle: async () => {
				await current?.then(
					() => undefined,
					() => undefined,
				);
			},
		};
		let disposal: Promise<void> | undefined;
		const handle: AgentHandle = {
			agent,
			dispose: () => {
				if (disposal) return disposal;
				disposal = (async () => {
					this.handles.delete(handle);
					status = "disposed";
					this.abort(sessionId);
					await agent.whenIdle();
				})();
				return disposal;
			},
		};
		this.handles.add(handle);
		return handle;
	}
}

/** @deprecated Use PiAgentLoop through `ctx.agents`; retained for source compatibility. */
export { PiAgentLoop as PiAgentRuntime };
