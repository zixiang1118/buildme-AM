import type { TraceTurn } from "./trace.js";
export interface CompareMetrics {
	modelCalls?: number; toolCalls?: number; tools: string[]; subagents?: number; compactions?: number;
	tokens?: number; durationMs?: number; files?: number; usage: "exact" | "estimated" | "none";
}
export function compareMetrics(turns: readonly (TraceTurn | undefined)[], durationMs?: number, files?: number): CompareMetrics {
	const known = [...new Map(turns.filter((turn): turn is TraceTurn => Boolean(turn)).map((turn) => [turn.id, turn])).values()];
	const complete = turns.length > 0 && turns.every(Boolean) && known.every((turn) => turn.fidelity.subagents), events = known.flatMap((turn) => [...new Map(turn.events.map((event) => [event.id, event])).values()]);
	const usage = complete && known.every((turn) => ["exact", "estimated"].includes(turn.fidelity.usage) && turn.usage.inputTokens !== undefined && turn.usage.outputTokens !== undefined) ? known.some((turn) => turn.fidelity.usage === "estimated") ? "estimated" : "exact" : "none";
	return {
		tools: [...new Set(events.filter((e) => e.type === "tool.call").map((e) => e.name))].sort(), usage,
		...(complete ? { modelCalls: events.filter((e) => e.type === "llm.request").length, toolCalls: events.filter((e) => e.type === "tool.call").length } : {}),
		...(complete && known.every((turn) => turn.fidelity.subagents) ? { subagents: new Set(events.filter((e) => e.type === "subagent.start").map((e) => e.childTurnId)).size } : {}),
		...(complete && known.every((turn) => turn.fidelity.compaction) ? { compactions: events.filter((e) => e.type === "context.compacted" || e.type === "context.clipped").length } : {}),
		...(usage !== "none" ? { tokens: known.reduce((sum, turn) => sum + turn.usage.inputTokens! + turn.usage.outputTokens! + (turn.usage.cacheReadTokens ?? 0) + (turn.usage.cacheWriteTokens ?? 0), 0) } : {}),
		...(durationMs === undefined ? {} : { durationMs }), ...(files === undefined ? {} : { files }),
	};
}
export function metricDifference(left: number | undefined, right: number | undefined): { delta?: number; percent?: number } {
	return left === undefined || right === undefined ? {} : { delta: right - left, ...(left === 0 ? {} : { percent: (right - left) / left * 100 }) };
}
