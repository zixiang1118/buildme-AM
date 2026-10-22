import { compareDenial, type ComparePolicy } from "../core/compare-policy.js";
import { DshTraceRecorder } from "./dsh-trace.js";
import { traceAttempt } from "../core/trace-redact.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { admitEncodedImages } from "@deepseek-ai/dsh-attachment";
import { parseChatImages } from "../core/chat-images.js";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

/**
 * BuildMe full edition bridge. This Cordis plugin is inserted into a DSH
 * profile (over @deepseek-ai/dsh-base) that BuildMe Desktop launches as a
 * child process with the official `dsh` launcher. It speaks newline-delimited
 * JSON-RPC on stdio, so the BuildMe UI drives the real DSH agent loop,
 * sub-agents, workflows, web tools and sandboxed bash.
 *
 * Desktop → DSH requests:
 *   initialize                 → { providers }
 *   tools/list                 → [{ name, description }] of the model-facing tools
 *   session/run                → run one user turn to quiescence → { sessionId, text, reason, error? }
 *   session/cancel             → cancel the live turn of a session
 *   session/list               → persisted root sessions
 *   session/messages           → user/assistant/tool messages of one session
 *   schedule/resume-pending    → bring sessions with pending reminders live so DSH's
 *                                schedule owner delivers them (overdue ones at once)
 *
 * DSH → Desktop:
 *   stream (notification)      → { sessionId, type: "text", delta } | { sessionId, type: "tool", name }
 *   status (notification)      → { sessionId, status: "idle" | "running" } for root sessions; lets
 *                                Desktop notice turns it did not start (scheduled reminders)
 *   approval/request (request) → { allow: boolean }; DSH waits for the answer
 *
 * Stdout belongs exclusively to JSON-RPC frames.
 */

export const name = "buildme-dsh-bridge";
export const inject = ["agents", "sessions", "sessionPersistence", "tools"];

type PermissionMode = "ask" | "workspace-write" | "bypass";

/** BuildMe permission modes mapped onto the DSH base permission presets. */
const PERMISSION_PRESETS: Readonly<Record<PermissionMode, string>> = {
	ask: "read-only",
	"workspace-write": "workspace-write",
	bypass: "danger-full-access",
};

interface RunParams {
	readonly sessionId?: string;
	readonly createSession?: boolean;
	readonly cwd?: string;
	readonly provider: string;
	readonly model: string;
	readonly text: string;
	readonly permissionMode?: PermissionMode;
}

interface BridgeMessage {
	readonly id: string;
	readonly role: "user" | "assistant" | "tool";
	readonly text: string;
	readonly reasoning?: string;
	readonly at: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("params must be an object");
	return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${key} must be a non-empty string`);
	return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function blocksText(content: unknown, includeToolCalls: boolean): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (includeToolCalls && block.type === "tool-call" && typeof block.name === "string") return `正在使用：${block.name}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Map one durable DSH session event to a BuildMe transcript message. */
function eventMessage(sessionId: string, event: any): BridgeMessage | undefined {
	let role: BridgeMessage["role"];
	let text: string;
	let reasoning = "";
	switch (event?.type) {
		case "user/message": {
			const message = event.data?.message ?? event.data;
			// Runtime context snapshots and system reminders are injected as user
			// messages with a non-user source; they are not part of the transcript.
			if (message?.source?.kind !== undefined && message.source.kind !== "user") return undefined;
			role = "user";
			text = blocksText(message?.content, false);
			break;
		}
		case "assistant/message":
			role = "assistant";
			text = blocksText(event.data?.message?.content, true);
			reasoning = event.data.message.content.filter((block: any) => block.type === "reasoning").map((block: any) => block.text).join("\n");
			break;
		case "tool/result":
			role = "tool";
			text = blocksText(event.data?.message?.content, false);
			break;
		default:
			return undefined;
	}
	if (!text && !reasoning) return undefined;
	const time = typeof event.time === "number" ? event.time : Date.now();
	return { id: `${sessionId}:${String(event.seq)}`, role, text, ...(reasoning ? { reasoning } : {}), at: new Date(time).toISOString() };
}

/** Last assistant text and turn outcome after `firstSeq` (same rule as dsh-headless). */
function summarize(session: any, firstSeq: number): { text: string; reason?: any } {
	let started = false;
	let text = "";
	let reason: any;
	for (let seq = firstSeq; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (!event) break;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = blocksText(event.data?.message?.content, false);
			if (joined) text = joined;
		}
		if (event.type === "turn/end") reason = event.data?.reason;
	}
	return { text, reason };
}

/**
 * Pending reminders of one session, folded from its `schedule/change` events:
 * create adds, delete removes, and a dispatch retires one-shot reminders while
 * recurring ones stay active.
 */
export function pendingSchedules(events: readonly any[]): { id: string; scheduledAt: string; kind: string }[] {
	const active = new Map<string, { id: string; scheduledAt: string; kind: string }>();
	for (const event of events) {
		if (event?.type !== "schedule/change") continue;
		const change = event.data;
		if (change?.operation === "create" && change.schedule?.id) {
			const record = change.schedule;
			active.set(String(record.id), { id: String(record.id), scheduledAt: String(record.scheduledAt), kind: String(record.kind) });
		} else if (change?.operation === "delete") {
			active.delete(String(change.id));
		} else if (change?.operation === "dispatch" && active.get(String(change.id))?.kind !== "every") {
			active.delete(String(change.id));
		}
	}
	return [...active.values()];
}

/** Find the raw arguments of a tool call so the approval dialog can show them. */
function toolCallArguments(session: any, callId: string | undefined): unknown {
	if (!callId || typeof session?.ownEvents !== "function") return undefined;
	const events: readonly any[] = session.ownEvents();
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "assistant/message") continue;
		const block = event.data?.message?.content?.find?.((candidate: any) => candidate?.type === "tool-call" && candidate.id === callId);
		if (!block) continue;
		try {
			return JSON.parse(block.arguments);
		} catch {
			return block.arguments;
		}
	}
	return undefined;
}

class DshBridge {
	private readonly trace: DshTraceRecorder;
	private readonly runningRequests = new Map<string, { cancelled: boolean }>();
	private readonly policies = new Map<string, ComparePolicy>();
	private readonly creations = new Map<string, Promise<any>>();
	private readonly disposers: (() => void)[] = [];

	constructor(private readonly ctx: Context, private readonly transport: JsonRpcLineTransport) {
		const c = ctx as any;
		this.disposers.push(c.tools.guard((exec: any) => {
			const policy = this.comparePolicy(exec.agent?.session);
			if (policy) {
				if (resolve(exec.agent.session.header.cwd) !== resolve(policy.workspaceRoot)) return "子任务的目录必须位于同一对比副本。";
				return compareDenial(policy, exec.name, exec.arguments);
			}
		}));
		this.trace = new DshTraceRecorder((notification) => transport.notify("trace", notification), [process.env.BUILDME_ACTIVE_API_KEY, process.env.DEEPSEEK_API_KEY]);
		this.disposers.push(c.on("session/created", (session: any) => { const inherited = this.comparePolicy(session); if (inherited) this.policies.set(String(session.id), inherited); }));
		this.disposers.push(c.on("session/event", (session: any, event: any) => traceAttempt(() => this.trace.sessionEvent(session, event))));
		this.disposers.push(c.on("llm/stream", (options: any, next: any) => this.trace.stream(options, next)));
		this.disposers.push(c.on("tools/pre-execute", (exec: any, next: any) => {
			traceAttempt(() => { if (exec.agent) this.trace.toolStart(String(exec.agent.session.id), String(exec.callId), exec.name, exec.arguments); });
			return next();
		}));
		this.disposers.push(c.on("tools/execute", (exec: any, next: any) => {
			traceAttempt(() => { if (exec.agent) this.trace.approval(String(exec.agent.session.id), String(exec.callId), "auto-allow"); });
			return next();
		}));
		this.disposers.push(c.on("tools/result", (exec: any, result: any) => traceAttempt(() => {
			if (exec.agent) this.trace.toolResult(String(exec.agent.session.id), String(exec.callId), exec.name, exec.arguments, result);
		})));
		this.disposers.push(c.on("agent/assistant-stream", ({ agent, frame }: any) => {
			if (agent?.session?.header?.parentSession !== undefined) return;
			const sessionId = String(agent.session.id);
			if (frame.type === "start") { this.transport.notify("stream", { sessionId, type: "response-start" }); return; }
			if (frame.type !== "chunk") return;
			const chunk = frame.chunk;
			if (chunk?.type === "text-delta" && chunk.text) {
				this.transport.notify("stream", { sessionId, type: "text", delta: chunk.text });
			} else if (chunk?.type === "reasoning-delta" && chunk.text) {
				this.transport.notify("stream", { sessionId, type: "reasoning", delta: chunk.text });
			} else if (chunk?.type === "block-end" && chunk.block?.type === "tool-call") {
				this.transport.notify("stream", { sessionId, type: "tool", name: chunk.block.name });
			}
		}));
		this.disposers.push(c.on("agent/status", ({ agent, status }: any) => {
			if (agent?.session?.header?.parentSession !== undefined) return;
			this.transport.notify("status", { sessionId: String(agent.session.id), status: String(status) });
		}));
		// Final approval answerer: every DSH `ask` decision goes to the BuildMe UI.
		this.disposers.push(c.on("approval/request", async (req: any) => {
			const session = req.agent?.session;
			const rootSessionId = String(session?.header?.parentSession ?? session?.id ?? "");
			try {
				const args = toolCallArguments(session, req.callId === undefined ? undefined : String(req.callId));
				const answer = asRecord(await this.transport.request("approval/request", {
					requestId: randomUUID(),
					sessionId: rootSessionId,
					turnId: this.trace.turnId(String(session?.id)),
					toolName: String(req.toolName ?? "工具"),
					...(req.callId === undefined ? {} : { toolCallId: String(req.callId) }),
					...(req.reason === undefined ? {} : { reason: String(req.reason) }),
					...(args === undefined ? {} : { args }),
				}, req.signal));
				traceAttempt(() => this.trace.approval(String(session?.id), String(req.callId), answer.allow === true ? "user-allow" : answer.decision === "cancelled" ? "cancelled" : answer.decision === "timeout" ? "timeout" : "user-deny"));
				return answer.allow === true ? "allowed-once" : answer.decision === "cancelled" ? "cancelled" : answer.decision === "timeout" ? "unavailable" : "rejected";
			} catch {
				traceAttempt(() => this.trace.approval(String(session?.id), String(req.callId), req.signal?.aborted ? "cancelled" : "policy-deny"));
				return req.signal?.aborted ? "cancelled" : "unavailable";
			}
		}));
	}

	dispose(): void {
		while (this.disposers.length) this.disposers.pop()?.();
	}

	async handle(method: string, raw: unknown): Promise<unknown> {
		switch (method) {
			case "initialize":
				await (this.ctx as any).get("loader")?.await();
				return {
					providers: ((this.ctx as any).get("llm")?.listProviders?.() ?? []).map((provider: any) => provider.id),
				};
			case "tools/list":
				return (((this.ctx as any).get("tools")?.schemas?.() ?? []) as any[]).map((schema) => ({
					name: String(schema.name),
					description: String(schema.description ?? "").split("\n")[0]!.slice(0, 200),
				}));
			case "session/run":
				return this.run(asRecord(raw));
			case "session/cancel":
				return this.cancel(requiredString(asRecord(raw), "sessionId"));
			case "session/list":
				return this.list();
			case "session/messages":
				return this.messages(requiredString(asRecord(raw), "sessionId"));
			case "schedule/resume-pending":
				return this.resumePending(asRecord(raw));
			default:
				throw new Error(`unknown BuildMe bridge method: ${method}`);
		}
	}

	private async agentFor(params: RunParams): Promise<any> {
		const agents = (this.ctx as any).agents;
		const selection = { provider: params.provider, model: params.model };
		const setup = (agentCtx: Context) => {
			installModelSelection(agentCtx, { current: selection, assembled: undefined } as never);
		};
		if (params.sessionId && !params.createSession) {
			const live = agents.get(params.sessionId);
			if (live) return live;
			const pending = this.creations.get(params.sessionId);
			if (pending) return pending;
			const resuming = agents.resume({
				resumeSessionId: brandString(params.sessionId),
				agentOptions: selection,
				setup,
			}).then((handle: any) => handle.agent);
			this.creations.set(params.sessionId, resuming);
			try {
				return await resuming;
			} finally {
				this.creations.delete(params.sessionId);
			}
		}
		const handle = await agents.create({
			sessionId: brandString(params.sessionId ?? `session-${randomUUID()}`),
			meta: { cwd: resolve(params.cwd ?? process.cwd()) },
			agentOptions: selection,
			setup,
		});
		return handle.agent;
	}

	private comparePolicy(session: any): ComparePolicy | undefined {
		if (!session) return undefined;
		const own = this.policies.get(String(session.id));
		if (own) return own;
		const parent = session.header.parentSession;
		if (!parent) return undefined;
		return this.policies.get(String(parent)) ?? this.comparePolicy((this.ctx as any).agents.get(String(parent))?.session);
	}

	private async run(raw: Record<string, unknown>) {
		const images = parseChatImages(raw.images);
		let imageContent: unknown[] = [];
		if (images.length) {
			const attachments = (this.ctx as any).get("attachments");
			if (!attachments) throw new Error("图片附件服务尚未就绪，请稍后重试。");
			const refs = await admitEncodedImages(attachments, images.map(image => ({ data: image.data, mediaType: image.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif" })));
			imageContent = refs.map(attachment => ({ type: "image", attachment }));
		}
		const permissionMode = optionalString(raw, "permissionMode") as PermissionMode | undefined;
		const params: RunParams = {
			createSession: raw.createSession === true,
			provider: requiredString(raw, "provider"),
			model: requiredString(raw, "model"),
			text: requiredString(raw, "text"),
			...(optionalString(raw, "sessionId") ? { sessionId: optionalString(raw, "sessionId")! } : {}),
			...(optionalString(raw, "cwd") ? { cwd: optionalString(raw, "cwd")! } : {}),
			...(permissionMode && permissionMode in PERMISSION_PRESETS ? { permissionMode } : {}),
		};
		const pending = { cancelled: false };
		if (params.sessionId) this.runningRequests.set(params.sessionId, pending);
		const agent = await this.agentFor(params);
		const sessionId = String(agent.session.id);
		if (raw.comparePolicy) {
			const policy = asRecord(raw.comparePolicy);
			this.policies.set(sessionId, Object.freeze({ workspaceRoot: requiredString(policy, "workspaceRoot"), readOnly: policy.readOnly === true }));
		}
		await agent.whenIdle();
		if (pending.cancelled) { this.runningRequests.delete(sessionId); return { sessionId, text: "", reason: "aborted" }; }
		const presets = (this.ctx as any).get("permissionPresets");
		const automaticComparison = this.comparePolicy(agent.session) && params.permissionMode === "bypass";
		const preset = PERMISSION_PRESETS[automaticComparison ? "workspace-write" : params.permissionMode ?? "ask"];
		if (presets && presets.current(agent.session) !== preset) presets.set(agent.session, preset);
		if (automaticComparison) setApprovalPolicy(agent.session, "never");

		const firstSeq = agent.session.seq;
		this.trace.configure(sessionId, { ...params, recordRawRequests: raw.recordRawRequests !== false, ...(optionalString(raw, "compareGroupId") ? { compareGroupId: optionalString(raw, "compareGroupId")! } : {}) });
		agent.followup(createUserMessage({ content: [{ type: "text", text: params.text }, ...imageContent], source: { kind: "user" } } as never));
		try { await agent.whenIdle(); } finally { this.runningRequests.delete(sessionId); traceAttempt(() => this.trace.backfill(agent.session, firstSeq)); }
		await (this.ctx as any).sessions.flush(agent.session);
		const outcome = summarize(agent.session, firstSeq);
		const reason = outcome.reason?.kind ?? "unknown";
		return {
			sessionId,
			text: outcome.text,
			reason,
			...(reason === "error" ? { error: `${outcome.reason.error?.code ?? "error"}: ${outcome.reason.error?.message ?? ""}` } : {}),
		};
	}

	private async cancel(sessionId: string) {
		const pending = this.runningRequests.get(sessionId); if (pending) pending.cancelled = true;
		const agents = (this.ctx as any).agents.list() as any[];
		const owned = new Set([sessionId]);
		for (let count = 0; count < agents.length; count++) for (const agent of agents) if (owned.has(String(agent.session.header.parentSession))) owned.add(String(agent.session.id));
		const active = agents.filter((agent) => owned.has(String(agent.session.id)));
		for (const agent of active) agent.cancel({ kind: "user" });
		await Promise.all(active.map((agent) => agent.whenIdle()));
		return { cancelled: active.length > 0 || Boolean(pending) };
	}

	private async list() {
		const persistence = (this.ctx as any).sessionPersistence;
		const snapshots: readonly any[] = await persistence.list();
		const live = new Map<string, any>(((this.ctx as any).agents.list() as any[]).map((agent) => [String(agent.id), agent]));
		return snapshots
			.filter((snapshot) => snapshot.header.parentSession === undefined)
			.map((snapshot) => ({
				id: String(snapshot.header.id),
				createdAt: new Date(snapshot.header.createdAt).toISOString(),
				...(snapshot.header.cwd ? { cwd: snapshot.header.cwd } : {}),
				...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }),
				status: live.get(String(snapshot.header.id))?.status ?? "idle",
			}))
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	private async readEvents(sessionId: string): Promise<readonly any[]> {
		const live = (this.ctx as any).agents.get(sessionId);
		if (live) return live.session.snapshotEvents();
		const handle = await (this.ctx as any).sessionPersistence.open(brandString(sessionId), "read");
		try {
			return (await handle.read()).events;
		} finally {
			await handle.close();
		}
	}

	private async resumePending(raw: Record<string, unknown>) {
		const provider = requiredString(raw, "provider");
		const model = requiredString(raw, "model");
		const snapshots: readonly any[] = await (this.ctx as any).sessionPersistence.list();
		const resumed: { sessionId: string; pending: number; nextAt: string }[] = [];
		for (const snapshot of snapshots) {
			if (snapshot.header.parentSession !== undefined) continue;
			const sessionId = String(snapshot.header.id);
			if ((this.ctx as any).agents.get(sessionId)) continue;
			let pending: ReturnType<typeof pendingSchedules>;
			try {
				pending = pendingSchedules(await this.readEvents(sessionId));
			} catch {
				continue;
			}
			if (pending.length === 0) continue;
			try {
				await this.agentFor({ sessionId, provider, model, text: "" });
				const nextAt = pending.map((item) => item.scheduledAt).sort()[0]!;
				resumed.push({ sessionId, pending: pending.length, nextAt });
			} catch {
				// A session that cannot be resumed keeps its reminders for a later attempt.
			}
		}
		return resumed;
	}

	private async messages(sessionId: string): Promise<BridgeMessage[]> {
		const events = await this.readEvents(sessionId);
		return events.flatMap((event) => {
			const message = eventMessage(sessionId, event);
			return message ? [message] : [];
		});
	}
}

export function apply(ctx: Context): void {
	const rootFiber = (ctx as any).root.fiber;
	const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
	const bridge = new DshBridge(ctx, transport);
	transport.onRequest((method, params) => bridge.handle(method, params));

	// Desktop closing stdin (quit or crash) shuts the whole DSH tree down.
	let exiting = false;
	const onEnd = (): void => {
		if (exiting) return;
		exiting = true;
		void Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]).then(() => process.exit(0));
	};
	process.stdin.once("end", onEnd);

	(ctx as any).effect(() => {
		transport.start();
		return () => {
			process.stdin.off("end", onEnd);
			bridge.dispose();
			transport.close();
		};
	}, "buildme.bridge");
}
