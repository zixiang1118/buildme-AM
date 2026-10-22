import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACHIEVEMENTS, AchievementEngine, matchesAchievement, type AchievementContext, type LearningEvent } from "../src/core/achievements.js";
import { ALL_CAPABILITIES } from "../src/core/capabilities.js";
import { CapabilityUsageStore } from "../src/core/capability-usage.js";
import type { TraceTurn, TraceEvent, TraceEventInput } from "../src/core/trace.js";
import { tempWorkspace } from "./helpers.js";

const at = "2026-10-05T00:00:00.000Z";
let index = 0;
const event = (input: TraceEventInput): TraceEvent => ({ ...input, id: `event-${++index}`, at });
function turn(values: Partial<TraceTurn> = {}): TraceTurn {
	return { id: "turn", engine: "pi", sessionId: "session", turnIndex: 1, startedAt: at, status: "error", userPrompt: "private-chat-sentinel", model: { provider: "faux", id: "one" }, fidelity: { promptSegments: true, rawRequest: true, usage: "exact", approvals: true, compaction: true, subagents: true }, capabilities: ["core"], promptSegments: [], events: [], usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 }, ...values };
}
function context(patch: Partial<AchievementContext> = {}): AchievementContext {
	return { input: { type: "turn", turn: turn() }, capabilities: ["core"], usage: {}, models: [], counters: { turns: 0, xrayOpened: 0, explained: 0, comparisons: 0 }, ...patch };
}
const withEvents = (...events: TraceEvent[]): Partial<AchievementContext> => ({ input: { type: "turn", turn: turn({ events }) } });
const call = (name = "bash", toolCallId = "tool", parallelGroup?: number) => event({ type: "tool.call", round: 1, name, toolCallId, args: { secret: "private-args-sentinel" }, ...(parallelGroup === undefined ? {} : { parallelGroup }) });
const result = (isError = false) => event({ type: "tool.result", toolCallId: "tool", isError, durationMs: 1, resultPreview: "private-result-sentinel", resultBytes: 2, truncated: false });
const approval = (decision: "user-allow" | "user-deny" | "cancelled" | "timeout") => event({ type: "tool.approval", toolCallId: "tool", decision, permissionMode: "ask" });
const ui = (value: Omit<LearningEvent, "id" | "at">): LearningEvent => ({ id: `ui-${++index}`, at, ...value } as LearningEvent);
const cases: Record<string, Partial<AchievementContext>> = {
	"first-turn": { input: { type: "turn", turn: turn({ status: "done" }) } },
	"first-tool": withEvents(call()), "first-bash": withEvents(call(), result()), "first-edit": withEvents(call("edit"), result()),
	"first-approval": withEvents(approval("user-allow")), "first-deny": withEvents(approval("user-deny")),
	"parallel-tools": withEvents(call("read", "a", 1), call("read", "b", 1)),
	"long-turn": { input: { type: "turn", turn: turn({ usage: { ...turn().usage, modelCalls: 10 } }) } },
	"xray-open": { input: ui({ type: "xray-opened" }) },
	"xray-prompt": { input: { id: "prompt", at, type: "xray-tab", tab: "prompt" } },
	"xray-raw": { input: { id: "raw", at, type: "xray-tab", tab: "raw" } },
	"explain-1": { counters: { ...context().counters, explained: 1 } },
	"explain-20": { counters: { ...context().counters, explained: 20 } },
	"explain-deep": { input: ui({ type: "explain-deep" }) },
	"cap-first": { input: { id: "cap", at, type: "capability-toggled", capabilities: ["core", "web"], enabledIds: ["web"] } },
	"cap-half": { capabilities: ALL_CAPABILITIES.slice(0, 6) },
	"cap-all": { capabilities: ALL_CAPABILITIES, usage: Object.fromEntries(ALL_CAPABILITIES.map((id) => [id, 1])) },
	"skill-load": withEvents(event({ type: "skill.load", name: "s", builtin: true, chars: 1 })),
	"skill-author": withEvents(event({ type: "skill.load", name: "s", builtin: false, chars: 1 })),
	"compaction": withEvents(event({ type: "context.compacted", tokensBefore: 100, coveredMessages: 2, summaryPreview: "private-summary" })),
	"overflow": withEvents(event({ type: "context.overflow", estTokens: 100, limit: 50 })),
	"subagent": withEvents(event({ type: "subagent.start", childTurnId: "child", kind: "delegate_task", task: "private-task" })),
	"workflow": withEvents(event({ type: "workflow.step", stepIndex: 0, title: "private-step", status: "start" })),
	"todo": withEvents(call("todo_manage")), "web": withEvents(call("web_fetch")),
	"compare-first": { counters: { ...context().counters, comparisons: 1 } },
	"compare-xray": { input: { id: "cx", at, type: "compare-xray-opened", toolsDiffer: true } },
	"compare-10": { counters: { ...context().counters, comparisons: 10 } },
	"compare-summary": { input: ui({ type: "compare-summary" }) },
	"model-switch": { models: ["faux/one", "faux/two"] },
};

describe("30 条成就规则", () => {
	it("keeps the requested IDs and names", () => {
		expect(ACHIEVEMENTS).toHaveLength(30);
		expect(Object.keys(cases).sort()).toEqual(ACHIEVEMENTS.map((a) => a.id).sort());
		expect(ACHIEVEMENTS.find((a) => a.id === "skill-author")!.name).toBe("自定义技能");
	});
	it.each(ACHIEVEMENTS)("$id matches only its positive fixture, not the empty fixture", ({ id }) => {
		expect(matchesAchievement(id, context(cases[id]))).toBe(true);
		expect(matchesAchievement(id, context())).toBe(false);
	});
	it("distinguishes rejection, cancellation, timeout, failed tools and builtin skills", () => {
		for (const decision of ["cancelled", "timeout"] as const) {
			expect(matchesAchievement("first-deny", context(withEvents(approval(decision))))).toBe(false);
			expect(matchesAchievement("first-approval", context({ input: { id: decision, at, type: "approval-answered", decision } }))).toBe(false);
		}
		expect(matchesAchievement("first-bash", context(withEvents(call(), result(true))))).toBe(false);
		expect(matchesAchievement("first-edit", context(withEvents(call("write"), result(true))))).toBe(false);
		expect(matchesAchievement("skill-author", context(cases["skill-load"]))).toBe(false);
		const one = call("read", "tool", 1);
		expect(matchesAchievement("parallel-tools", context(withEvents(one, one)))).toBe(false);
	});
	it("requires all nine actual usages, explicit disabled compaction and trustworthy DSH observations", () => {
		expect(matchesAchievement("cap-all", context({ ...cases["cap-all"], usage: { ...cases["cap-all"]!.usage, compaction: 0 } }))).toBe(false);
		expect(matchesAchievement("cap-all", context({ ...cases["cap-all"], capabilities: ALL_CAPABILITIES.filter((id) => id !== "web") }))).toBe(false);
		for (const [id, fidelityKey] of [["subagent", "subagents"], ["compaction", "compaction"], ["first-deny", "approvals"]] as const) {
			const input = cases[id]!.input!; if (input.type !== "turn") throw new Error("Expected turn fixture");
			const dsh = turn({ ...input.turn, engine: "dsh" });
			expect(matchesAchievement(id, context({ input: { type: "turn", turn: dsh } }))).toBe(true);
			expect(matchesAchievement(id, context({ input: { type: "turn", turn: { ...dsh, fidelity: { ...dsh.fidelity, [fidelityKey]: false } } } }))).toBe(false);
		}
		const input = cases.overflow!.input!; if (input.type !== "turn") throw new Error("Expected turn fixture");
		expect(matchesAchievement("overflow", context({ input: { type: "turn", turn: { ...input.turn, capabilities: ALL_CAPABILITIES } } }))).toBe(false);
		expect(matchesAchievement("compare-xray", context({ input: { id: "same", at, type: "compare-xray-opened", toolsDiffer: false } }))).toBe(false);
	});
});

describe("成就持久化", () => {
	it("deduplicates concurrent turn and UI replay across restarts and exports no conversation data", async () => {
		const f = await tempWorkspace();
		try {
			const path = join(f.dir, "achievements.json"), usagePath = join(f.dir, "usage.json");
			const engine = new AchievementEngine(path, new CapabilityUsageStore(usagePath));
			const input = { type: "turn" as const, turn: turn({ status: "done", events: [call("web_fetch"), result()] }) };
			const [first, second] = await Promise.all([engine.accept(input), engine.accept(input)]);
			expect(first.map((a) => a.id)).toEqual(["first-turn", "first-tool", "web"]); expect(second).toEqual([]);
			const clicked = { id: "click", at, type: "explain-clicked" as const, turnId: "turn" };
			await Promise.all([engine.accept(clicked), engine.accept(clicked)]);
			for (let i = 0; i < 10; i++) await engine.accept({ id: `comparison-${i}`, at, type: "compare-completed", compareGroupId: `group-${i}` });
			await engine.accept({ id: "duplicate-group", at, type: "compare-completed", compareGroupId: "group-0" });
			const restored = new AchievementEngine(path, new CapabilityUsageStore(usagePath));
			expect(await restored.accept(input)).toEqual([]); expect(await restored.accept(clicked)).toEqual([]);
			const data = await restored.snapshot(["core"]);
			expect(data.counters).toMatchObject({ turns: 1, explained: 1, comparisons: 10, capabilityUsage: { web: 1, compaction: 0 } });
			expect(data.achievements.find((a) => a.id === "explain-1")!.turnId).toBe("turn");
			expect(data.achievements.some((a) => a.id === "compare-10")).toBe(true);
			expect(Object.keys(data).sort()).toEqual(["achievements", "capabilities", "counters"]);
			for (const text of [JSON.stringify(data), await readFile(path, "utf8")]) {
				expect(text).not.toContain("private-"); expect(text).not.toContain("toolCallId"); expect(text).not.toContain("events");
			}
		} finally { await f.cleanup(); }
	});
	it("only counts completed model identities and unlocks explanation thresholds once", async () => {
		const f = await tempWorkspace();
		try {
			const engine = new AchievementEngine(join(f.dir, "achievements.json"), new CapabilityUsageStore(join(f.dir, "usage.json")));
			await engine.accept({ type: "turn", turn: turn({ status: "running" }) });
			await engine.accept({ type: "turn", turn: turn({ status: "done" }) });
			await engine.accept({ type: "turn", turn: turn({ id: "failed", model: { provider: "faux", id: "two" } }) });
			expect((await engine.snapshot(["core"])).achievements.some((a) => a.id === "model-switch")).toBe(false);
			expect((await engine.accept({ type: "turn", turn: turn({ id: "second", status: "done", model: { provider: "faux", id: "two" } }) })).map((a) => a.id)).toContain("model-switch");
			for (let i = 1; i <= 20; i++) {
				const unlocks = await engine.accept({ id: `click-${i}`, at, type: "explain-clicked" });
				expect(unlocks.some((a) => a.id === "explain-20")).toBe(i === 20);
			}
		} finally { await f.cleanup(); }
	});
	it("reports storage failure and does not fabricate persisted unlocks", async () => {
		const f = await tempWorkspace();
		try {
			await writeFile(join(f.dir, "blocked"), "file");
			const engine = new AchievementEngine(join(f.dir, "blocked", "achievements.json"), new CapabilityUsageStore(join(f.dir, "usage.json")));
			await expect(engine.accept({ type: "turn", turn: turn({ status: "done" }) })).rejects.toThrow();
		} finally { await f.cleanup(); }
	});
});
