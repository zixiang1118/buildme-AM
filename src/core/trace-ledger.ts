import { estimateTokens, type TraceContextItem, type TraceTurn, type TraceUsage } from "./trace.js";

const KINDS = { system: "系统消息", user: "用户消息", assistant: "助手消息", tool: "工具结果" };
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

function toolLabel(name: string, args: unknown): string {
	if (args && typeof args === "object") {
		for (const key of ["path", "file_path", "file", "url"]) {
			const value = (args as Record<string, unknown>)[key];
			if (typeof value === "string") return `${name} · ${value}`;
		}
	}
	return name;
}

export function turnLedger(turn: TraceTurn) {
	const events = [...new Map(turn.events.map((event) => [event.id, event])).values()];
	const requests = events.filter((event) => event.type === "llm.request");
	const responses = new Map(events.filter((event) => event.type === "llm.response").map((event) => [event.round, event]));
	const calls = new Map(events.filter((event) => event.type === "tool.call").map((event) => [event.toolCallId, event]));
	const content = new Map<string, TraceContextItem & { label: string; rounds: number[]; eventIds: string[]; cumulative: number }>();
	const toolOutputs = new Map<string, { label: string; eventId?: string; estTokens: number; cumulative: number; rounds: number[]; source: "context" | "saved"; truncated: boolean }>();
	for (const request of requests) {
		for (const item of request.contextItems ?? []) {
			const call = item.toolCallId ? calls.get(item.toolCallId) : undefined;
			const label = item.kind === "tool" ? call ? toolLabel(call.name, call.args) : item.toolName ?? "工具结果" : `${KINDS[item.kind]} · 首次记录位置 ${item.position}`;
			let entry = content.get(item.key);
			if (!entry) { entry = { ...item, label, rounds: [], eventIds: [], cumulative: 0 }; content.set(item.key, entry); }
			entry.rounds.push(request.round); entry.eventIds.push(request.id); entry.cumulative += item.estTokens;
			if (item.kind === "tool" && item.toolCallId) {
				let output = toolOutputs.get(item.toolCallId);
				if (!output) {
					output = { label, ...(call ? { eventId: call.id } : {}), estTokens: 0, cumulative: 0, rounds: [], source: "context", truncated: false };
					toolOutputs.set(item.toolCallId, output);
				}
				output.estTokens = Math.max(output.estTokens, item.estTokens); output.cumulative += item.estTokens;
				if (!output.rounds.includes(request.round)) output.rounds.push(request.round);
			}
		}
	}
	for (const event of events) {
		if (event.type !== "tool.result") continue;
		const call = calls.get(event.toolCallId), output = toolOutputs.get(event.toolCallId);
		if (output) { output.truncated = event.truncated; continue; }
		toolOutputs.set(event.toolCallId, { label: call ? toolLabel(call.name, call.args) : "工具结果", ...(call ? { eventId: call.id } : {}), estTokens: estimateTokens(event.result ?? event.resultPreview), cumulative: 0, rounds: [], source: "saved", truncated: event.truncated });
	}
	const completeUsage = turn.status !== "running" && turn.fidelity.usage !== "none" && requests.length > 0 && requests.every((request) => responses.get(request.round)?.usage !== undefined);
	const usage: Partial<TraceUsage> = {};
	const reported = requests.filter((request) => responses.get(request.round)?.usage !== undefined);
	if (reported.length) {
		for (const [target, source] of [["inputTokens", "input"], ["outputTokens", "output"], ["cacheReadTokens", "cacheRead"], ["cacheWriteTokens", "cacheWrite"]] as const) {
			const values = reported.map((request) => responses.get(request.round)!.usage![source]);
			if (values.every((value) => value !== undefined)) usage[target] = values.reduce((sum, value) => sum + value, 0);
		}
	}
	return {
		turnId: turn.id, engine: turn.engine, model: turn.model, status: turn.status, fidelity: turn.fidelity.usage, usage,
		completeUsage, reportedCalls: reported.length, missingCalls: requests.length - reported.length, contextCoverage: requests.filter((request) => request.contextItems !== undefined).length, requestCount: requests.length,
		calls: requests.map((request) => {
			const usage = responses.get(request.round)?.usage;
			return { eventId: request.id, round: request.round, estimatedInput: request.context.total, context: request.context,
				...(usage ? { usage, reportedInput: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) } : {}) };
		}).sort((a, b) => (b.reportedInput ?? b.estimatedInput) - (a.reportedInput ?? a.estimatedInput)),
		toolOutputs: [...toolOutputs.values()].sort((a, b) => (b.source === "context" ? b.cumulative : b.estTokens) - (a.source === "context" ? a.cumulative : a.estTokens)),
		repeated: [...content.values()].filter((item) => item.rounds.length > 1).sort((a, b) => b.cumulative - a.cumulative),
	};
}

export async function tokenLedger(turn: TraceTurn, lookup: (id: string) => Promise<TraceTurn | undefined>) {
	const agents = [{ ...turnLedger(turn), label: "当前 Agent" }], missing: string[] = [], seen = new Set([turn.id]);
	let complete = turn.fidelity.subagents;
	async function visit(parent: TraceTurn): Promise<void> {
		for (const event of parent.events) {
			if (event.type !== "subagent.start" || seen.has(event.childTurnId)) continue;
			seen.add(event.childTurnId);
			const child = await lookup(event.childTurnId);
			if (!child || child.parentTurnId !== parent.id) { missing.push(event.childTurnId); complete = false; continue; }
			agents.push({ ...turnLedger(child), label: `子 Agent ${agents.length}` });
			complete = complete && child.fidelity.subagents;
			await visit(child);
		}
	}
	await visit(turn);
	const total: Partial<TraceUsage> = {};
	if (complete && agents.every((agent) => agent.completeUsage)) for (const key of USAGE_KEYS) {
		const values = agents.map((agent) => agent.usage[key]);
		if (values.every((value) => value !== undefined)) total[key] = values.reduce((sum, value) => sum + value, 0);
	}
	return { turnId: turn.id, agents, missing, complete, total };
}
