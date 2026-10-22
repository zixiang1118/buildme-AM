import { describe, expect, it } from "vitest";
import { traceContextItems } from "../src/core/trace-context.js";
import { tokenLedger, turnLedger } from "../src/core/trace-ledger.js";
import { traceMoment, traceSummary, type TraceEvent, type TraceEventInput, type TraceTurn } from "../src/core/trace.js";

let sequence = 0;
const event = (input: TraceEventInput): TraceEvent => ({ ...input, id: `event-${++sequence}`, at: "2026-10-07T00:00:00Z" });
const request = (round: number, contextItems?: ReturnType<typeof traceContextItems>) => event({ type: "llm.request", round, messageCount: 2, toolNames: ["read"], context: { systemPrompt: 10, toolDefinitions: 10, userMessages: 10, assistantMessages: 10, toolResults: 60, summary: 0, total: 100 }, ...(contextItems ? { contextItems } : {}) });
const response = (round: number, usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => event({ type: "llm.response", round, durationMs: 5, textPreview: "done", toolCalls: [], ...(usage ? { usage } : {}) });
const call = (name = "read", round = 1, id = "call") => event({ type: "tool.call", round, toolCallId: id, name, args: { path: "a.txt" } });
const result = (isError: boolean, truncated = false) => event({ type: "tool.result", toolCallId: "call", durationMs: 5, isError, resultPreview: "saved text", resultBytes: 10, truncated });
function turn(events: TraceEvent[], changes: Partial<TraceTurn> = {}): TraceTurn {
	return { id: "root", engine: "pi", sessionId: "session", turnIndex: 1, startedAt: "2026-10-07T00:00:00Z", status: "done", userPrompt: "fix", model: { provider: "local", id: "test" }, fidelity: { usage: "exact", rawRequest: false, promptSegments: true, subagents: true, compaction: true, approvals: true }, promptSegments: [], events, usage: { modelCalls: 2, toolCalls: 1, durationMs: 10 }, ...changes };
}

describe("本轮值得看的一幕", () => {
	it("links the error and a later changed invocation without claiming success", () => {
		const failed = call(), next = call("files_search", 2, "next");
		const trace = turn([failed, result(true), next]);
		expect(traceMoment(trace)).toMatchObject({ eventIds: [failed.id, next.id], title: "工具报错后，出现了不同的调用" });
		expect(traceSummary(trace).moment?.description).toContain("不代表问题已经修好");
		expect(traceMoment({ ...trace, status: "running" })).toBeUndefined();
	});
	it("does not mistake parallel calls, identical retries or successful results for changed strategy", () => {
		expect(traceMoment(turn([call(), result(true), call("files_search", 1, "parallel")]))).toBeUndefined();
		expect(traceMoment(turn([call(), result(true), call("read", 2, "retry")]))).toBeUndefined();
		expect(traceMoment(turn([call(), result(false), call("files_search", 2, "next")]))).toBeUndefined();
	});
	it("selects one observed compaction or skill and scopes first-time wording to this turn", () => {
		const skill = event({ type: "skill.load", name: "guide", chars: 50, builtin: false });
		const compact = event({ type: "context.compacted", tokensBefore: 100, coveredMessages: 3, summaryPreview: "summary" });
		expect(traceMoment(turn([skill, compact]))?.eventIds).toEqual([compact.id]);
		expect(traceMoment(turn([skill]))?.description).toContain("本回合第一次");
		expect(traceMoment(turn([]))).toBeUndefined();
	});
});

describe("Token 账单", () => {
	it("records content fingerprints and estimates without message text, and distinguishes duplicate occurrences", () => {
		const messages = [{ kind: "user" as const, content: "private message" }, { kind: "user" as const, content: "private message" }];
		const items = traceContextItems(messages);
		expect(items[0]!.key).not.toBe(items[1]!.key);
		expect(traceContextItems(messages)).toEqual(items);
		expect(JSON.stringify(items)).not.toContain("private message");
		expect(items[0]!.estTokens).toBe(4);
	});
	it("ranks requests by reported input including separate caches and never counts output as input", () => {
		const ledger = turnLedger(turn([request(1), response(1, { input: 5, output: 900, cacheRead: 40, cacheWrite: 10 }), request(2), response(2, { input: 60, output: 1, cacheRead: 0, cacheWrite: 0 })]));
		expect(ledger.calls.map((item) => item.round)).toEqual([2, 1]);
		expect(ledger.calls.map((item) => item.reportedInput)).toEqual([60, 55]);
		expect(ledger.usage).toEqual({ inputTokens: 65, outputTokens: 901, cacheReadTokens: 40, cacheWriteTokens: 10 });
	});
	it("keeps absent cache, unfinished requests and missing usage unknown", () => {
		const trace = turn([request(1), response(1, { input: 10, output: 2 }), request(2)]);
		expect(turnLedger(trace).completeUsage).toBe(false);
		expect(turnLedger(trace)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 }, reportedCalls: 1, missingCalls: 1 });
		expect(turnLedger(trace).calls.find((item) => item.round === 2)).not.toHaveProperty("reportedInput");
		const complete = turnLedger(turn(trace.events.slice(0, 2)));
		expect(complete.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
	});
	it("tracks repeated content from actual requests, including clipped variants, without needing raw recording", () => {
		const first = traceContextItems([{ kind: "user", content: "question" }, { kind: "tool", content: "a".repeat(240), toolCallId: "call", toolName: "read" }]);
		const shorter = traceContextItems([{ kind: "user", content: "question" }, { kind: "tool", content: "a".repeat(40), toolCallId: "call", toolName: "read" }]);
		const ledger = turnLedger(turn([call(), result(false), request(1, first), request(2, first), request(3, shorter)]));
		expect(ledger.contextCoverage).toBe(3);
		expect(ledger.toolOutputs[0]).toMatchObject({ source: "context", estTokens: 60, cumulative: 130, rounds: [1, 2, 3] });
		expect(ledger.repeated.find((item) => item.kind === "tool")).toMatchObject({ cumulative: 120, rounds: [1, 2] });
		expect(ledger.repeated.find((item) => item.kind === "user")?.rounds).toEqual([1, 2, 3]);
	});
	it("labels saved historical output as length only instead of inventing request appearances", () => {
		const ledger = turnLedger(turn([call(), result(false, true), request(1)]));
		expect(ledger.toolOutputs[0]).toMatchObject({ source: "saved", rounds: [], truncated: true });
		expect(ledger.contextCoverage).toBe(0); expect(ledger.repeated).toEqual([]);
	});
	it("deduplicates child turns and sums actual parent and child costs once", async () => {
		const usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1 };
		const start = event({ type: "subagent.start", childTurnId: "child", task: "read", kind: "delegate" });
		const root = turn([request(1), response(1, usage), start, start]);
		const child = turn([request(1), response(1, usage)], { id: "child", parentTurnId: "root" });
		const ledger = await tokenLedger(root, async () => child);
		expect(ledger.agents).toHaveLength(2);
		expect(ledger.total).toEqual({ inputTokens: 20, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 2 });
	});
	it("withholds aggregate costs when child records or cross-worker coverage are missing", async () => {
		const root = turn([request(1), response(1, { input: 10, output: 2 }), event({ type: "subagent.start", childTurnId: "missing", task: "read", kind: "delegate" })]);
		const ledger = await tokenLedger(root, async () => undefined);
		expect(ledger.total).toEqual({}); expect(ledger.missing).toEqual(["missing"]);
		expect(ledger.agents[0]!.usage.inputTokens).toBe(10);
		const incomplete = await tokenLedger({ ...root, events: root.events.slice(0, 2), fidelity: { ...root.fidelity, subagents: false } }, async () => undefined);
		expect(incomplete.total).toEqual({}); expect(incomplete.complete).toBe(false);
	});
});
