import { randomUUID } from "node:crypto";
import type { GenerateOptions, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";
import { estimateTokens, refreshTraceUsage, updateTraceUsage, type TraceEvent, type TraceEventInput, type TraceNotification, type TraceTurn } from "../core/trace.js";
import { limitTraceRaw, TRACE_PREVIEW_BYTES, TRACE_RESULT_BYTES } from "../core/trace-collector.js";
import { redactTrace, traceAttempt, truncateUtf8 } from "../core/trace-redact.js";
import { traceContextItems } from "../core/trace-context.js";

interface SessionEvent { type: string; seq: number; time: number; data: Record<string, unknown> }
interface Session {
	id: string; seq: number; header: { parentSession?: string };
	eventAt(seq: number): SessionEvent | undefined;
}
interface RunMetadata { provider: string; model: string; text: string; permissionMode?: string; compareGroupId?: string; recordRawRequests?: boolean }
interface RecordState {
	turn: TraceTurn; session: Session; seen: Set<string>; round: number;
	toolStarts: Map<string, number>; approved: Set<string>; linked: boolean; metadata: RunMetadata;
	pendingPrune?: number;
}
function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

export class DshTraceRecorder {
	private readonly metadata = new Map<string, RunMetadata>();
	private readonly records = new Map<string, RecordState>();
	private readonly processed = new Set<string>();
	constructor(private readonly publish: (notification: TraceNotification) => void, private readonly secrets: readonly (string | undefined)[] = []) {}

	configure(sessionId: string, metadata: RunMetadata): void { this.metadata.set(sessionId, { ...metadata }); }
	turnId(sessionId: string): string | undefined { return this.records.get(sessionId)?.turn.id; }
	private send(notification: TraceNotification): void { traceAttempt(() => this.publish(redactTrace(structuredClone(notification), this.secrets))); }
	private add(record: RecordState, key: string, input: TraceEventInput, time = Date.now()): void {
		if (record.seen.has(key)) return;
		record.seen.add(key);
		const event = redactTrace({ ...input, id: key, at: new Date(time).toISOString() }, this.secrets) as TraceEvent;
		record.turn.events.push(event); updateTraceUsage(record.turn.usage, event);
		limitTraceRaw(record.turn.events);
		this.send({ type: "event", turnId: record.turn.id, event });
	}
	private link(record: RecordState): void {
		if (record.linked || !record.turn.parentTurnId) return;
		const parent = this.records.get(record.session.header.parentSession!);
		if (!parent || parent.turn.id !== record.turn.parentTurnId) return;
		record.linked = true;
		this.add(parent, `child:${record.turn.id}:start`, { type: "subagent.start", childTurnId: record.turn.id, kind: "dsh", task: record.turn.userPrompt });
	}

	sessionEvent(session: Session, event: SessionEvent): void {
		const key = `${session.id}:${event.seq}`;
		if (this.processed.has(key)) return;
		this.processed.add(key);
		if (event.type === "turn/start") {
			const parent = session.header.parentSession ? this.records.get(session.header.parentSession) : undefined;
			const metadata = this.metadata.get(session.id) ?? parent?.metadata ?? { provider: "unknown", model: "unknown", text: "" };
			const turn: TraceTurn = {
				id: randomUUID(), engine: "dsh", sessionId: session.id, turnIndex: Number(event.data.turn), startedAt: new Date(event.time).toISOString(), status: "running",
				userPrompt: "", model: { provider: metadata.provider, id: metadata.model },
				...(parent ? { parentTurnId: parent.turn.id } : {}), ...(metadata.compareGroupId ? { compareGroupId: metadata.compareGroupId } : {}),
				fidelity: { promptSegments: false, rawRequest: metadata.recordRawRequests !== false, usage: "none", subagents: true, compaction: true, approvals: true },
				promptSegments: [], events: [], usage: { modelCalls: 0, toolCalls: 0, durationMs: 0 },
			};
			const record: RecordState = { turn, session, metadata, seen: new Set(), round: 0, toolStarts: new Map(), approved: new Set(), linked: false };
			this.records.set(session.id, record); this.send({ type: "turn-start", turn }); return;
		}
		const record = this.records.get(session.id);
		if (!record || record.turn.status !== "running") return;
		const data = event.data;
		if (event.type === "user/message") {
			const message = data as unknown as { content: unknown; source?: { kind: string } };
			if (message.source?.kind === undefined || message.source.kind === "user") Object.assign(record.turn, { userPrompt: textContent(message.content) });
			this.link(record);
			if (record.pendingPrune !== undefined) {
				this.add(record, `${key}:prune`, { type: "context.clipped", charsBefore: record.pendingPrune, charsAfter: JSON.stringify(message.content).length }, event.time);
				delete record.pendingPrune;
			}
		} else if (event.type === "assistant/message") {
			const message = data.message as { content: unknown };
			const text = textContent(message.content); if (text) record.turn.finalAnswer = text;
		} else if (event.type === "compaction/summary") {
			this.add(record, key, { type: "context.compacted", tokensBefore: Number(data.shadowedTokenCount), coveredMessages: (data.shadowedSeqs as number[]).length, summaryPreview: truncateUtf8(textContent(data.summary), TRACE_PREVIEW_BYTES) }, event.time);
		} else if (event.type === "compaction/prune") {
			record.pendingPrune = (data.shadowedSeqs as number[]).reduce((sum, seq) => sum + JSON.stringify(session.eventAt(seq)!.type === "user/message" ? session.eventAt(seq)!.data.content : (session.eventAt(seq)!.data.message as { content: unknown }).content).length, 0);
		} else if (event.type === "turn/end") {
			const reason = data.reason as { kind: string; error?: { message: string } } | null;
			record.turn.status = reason?.kind === "aborted" ? "aborted" : reason?.kind === "completed" || reason?.kind === "max-tokens" ? "done" : "error";
			if (record.turn.status === "error") record.turn.errorMessage = reason?.error?.message ?? `DSH 回合结束：${reason?.kind ?? "unknown"}`;
			record.turn.endedAt = new Date(event.time).toISOString(); record.turn.usage.durationMs = event.time - Date.parse(record.turn.startedAt);
			refreshTraceUsage(record.turn);
			this.link(record); this.send({ type: "turn-end", turn: record.turn });
			const parent = session.header.parentSession ? this.records.get(session.header.parentSession) : undefined;
			if (parent && parent.turn.id === record.turn.parentTurnId) this.add(parent, `child:${record.turn.id}:end`, { type: "subagent.end", childTurnId: record.turn.id, durationMs: record.turn.usage.durationMs, resultPreview: truncateUtf8(record.turn.finalAnswer ?? "", TRACE_PREVIEW_BYTES), isError: record.turn.status !== "done" });
		}
	}

	backfill(session: Session, firstSeq: number): void {
		for (let seq = firstSeq; seq < session.seq; seq++) {
			const event = session.eventAt(seq); if (event) this.sessionEvent(session, event);
		}
	}

	async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
		const record = options.sessionId ? this.records.get(options.sessionId) : undefined;
		if (!record || record.turn.status !== "running" || options.purpose === "session-title") { yield* next(); return; }
		const round = ++record.round, started = Date.now();
		traceAttempt(() => {
			Object.assign(record.turn.model, { provider: options.provider, id: options.model });
			const parts = { systemPrompt: estimateTokens(options.system ?? ""), toolDefinitions: estimateTokens(JSON.stringify(options.tools ?? [])), userMessages: 0, assistantMessages: 0, toolResults: 0, summary: 0 };
			for (const message of options.messages) {
				const tokens = estimateTokens(JSON.stringify(message.content));
				if (message.role === "system") parts.systemPrompt += tokens;
				else if (message.source.kind === "tool") parts.toolResults += tokens;
				else if (message.role === "user") parts.userMessages += tokens;
				else if (message.role === "assistant") parts.assistantMessages += tokens;
				else parts.toolResults += tokens;
			}
			const request = { ...options }; delete request.signal;
			const contextItems = traceContextItems(options.messages.map((message) => message.source.kind === "tool"
				? { kind: "tool", content: message.content, toolCallId: message.source.callId }
				: { kind: message.role, content: message.content }));
			this.add(record, `${record.turn.id}:request:${round}`, { type: "llm.request", round, messageCount: options.messages.length, toolNames: (options.tools ?? []).map((tool) => tool.name), context: { ...parts, total: Object.values(parts).reduce((sum, count) => sum + count, 0) }, contextItems, ...(record.metadata.recordRawRequests !== false ? { raw: { format: "dsh-generate-options", request } } : {}) });
		});
		let usage: TokenUsage | undefined, stopReason: string | undefined, text = "", reasoning = "", reasoningTruncated = false;
		const toolCalls: { toolCallId: string; name: string }[] = [];
		try {
			for await (const chunk of next()) {
				traceAttempt(() => {
					if (chunk.type === "text-delta") text += chunk.text;
					else if (chunk.type === "reasoning-delta") { const joined = reasoning + chunk.text; reasoning = truncateUtf8(joined, TRACE_RESULT_BYTES); reasoningTruncated ||= reasoning !== joined; }
					else if (chunk.type === "usage") usage = chunk.usage;
					else if (chunk.type === "finish") stopReason = chunk.reason.kind;
					else if (chunk.type === "block-end" && chunk.block.type === "tool-call") toolCalls.push({ toolCallId: chunk.block.id, name: chunk.block.name });
				});
				yield chunk;
			}
		} finally {
			traceAttempt(() => {
				this.add(record, `${record.turn.id}:response:${round}`, { type: "llm.response", round, durationMs: Date.now() - started, ...(stopReason ? { stopReason } : {}), ...(reasoning ? { reasoning, reasoningTruncated } : {}), textPreview: truncateUtf8(text, TRACE_PREVIEW_BYTES), toolCalls, ...(usage ? { usage: { input: usage.inputTokens, output: usage.outputTokens, ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }), ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }) } } : {}) });
			});
		}
	}

	toolStart(sessionId: string, callId: string, name: string, args: unknown): void {
		const record = this.records.get(sessionId); if (!record) return;
		if (name === "workflow" || name === "run_code") Object.assign(record.turn.fidelity, { subagents: false });
		if (!record.toolStarts.has(callId)) record.toolStarts.set(callId, Date.now());
		this.add(record, `${record.turn.id}:tool:${callId}`, { type: "tool.call", round: record.round, toolCallId: callId, name, args });
	}
	approval(sessionId: string, callId: string, decision: Extract<TraceEvent, { type: "tool.approval" }>["decision"], reason?: string): void {
		const record = this.records.get(sessionId); if (!record || record.approved.has(callId)) return;
		record.approved.add(callId);
		this.add(record, `${record.turn.id}:approval:${callId}`, { type: "tool.approval", toolCallId: callId, decision, permissionMode: record.metadata.permissionMode ?? "ask", ...(reason ? { reason } : {}) });
	}
	toolResult(sessionId: string, callId: string, name: string, args: unknown, result: { isError: boolean; content: unknown; error?: { info?: { code: string } } }): void {
		const record = this.records.get(sessionId); if (!record) return;
		this.toolStart(sessionId, callId, name, args);
		if (!record.approved.has(callId)) this.approval(sessionId, callId, result.error?.info?.code?.startsWith("ABORTED") ? "cancelled" : "policy-deny", "工具未进入获准执行阶段。");
		const safe = JSON.stringify(redactTrace(result, this.secrets));
		this.add(record, `${record.turn.id}:result:${callId}`, { type: "tool.result", toolCallId: callId, durationMs: Date.now() - record.toolStarts.get(callId)!, isError: result.isError, resultPreview: truncateUtf8(safe, TRACE_PREVIEW_BYTES), resultBytes: Buffer.byteLength(safe), truncated: Buffer.byteLength(safe) > TRACE_RESULT_BYTES, result: truncateUtf8(safe, TRACE_RESULT_BYTES) });
	}
}
