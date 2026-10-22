import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompareCoordinator, type CompareRunner } from "../src/core/compare-coordinator.js";
import { CompareWorkspace } from "../src/core/compare-workspace.js";
import { compareMetrics, metricDifference } from "../src/core/compare-metrics.js";
import type { TraceTurn } from "../src/core/trace.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(runner: CompareRunner) {
	const root = await mkdtemp(join(tmpdir(), "buildme-pair-")); roots.push(root); const workspace = join(root, "source"); await mkdir(workspace);
	const workspaces = new CompareWorkspace(join(root, "workspaces")), notify = vi.fn(), completed = vi.fn(async () => {});
	const coordinator = new CompareCoordinator(join(root, "groups"), workspaces, runner, notify, completed);
	const connection = { id: "fake", provider: "fake", model: "fake-1" };
	const group = await coordinator.create({ kind: "harness", workspace, left: { engine: "pi", connection, capabilities: ["core"] }, right: { engine: "dsh", connection, capabilities: ["core"] } });
	return { coordinator, root, group, workspaces, notify, completed };
}
describe("comparison coordination", () => {
	it("runs two independent sessions, streams separately, persists rounds and resumes snapshots", async () => {
		const called: string[] = [];
		const f = await setup({ run: async (g, side, round, _signal, stream) => { called.push(g.sides[side].sessionId); stream(side); return { text: `${side} ${round.prompt}` }; } });
		await f.coordinator.send(f.group.id, "one"); await f.coordinator.settle(f.group.id);
		expect(new Set(called).size).toBe(2); expect(f.completed).toHaveBeenCalledTimes(1);
		expect(f.notify.mock.calls.filter(([e]) => e.type === "stream").map(([e]) => e.side).sort()).toEqual(["left", "right"]);
		const restored = new CompareCoordinator(join(f.root, "groups"), f.workspaces, { run: async () => ({ text: "resumed" }) }, vi.fn(), vi.fn());
		expect((await restored.get(f.group.id)).rounds[0]!.runs.right.text).toBe("right one");
		await restored.send(f.group.id, "two"); await restored.settle(f.group.id);
		expect((await restored.get(f.group.id)).rounds).toHaveLength(2);
		expect((await restored.get(f.group.id)).sides.left.connection).toEqual(f.group.sides.left.connection);
		await restored.remove(f.group.id);
		expect(await restored.list()).toEqual([]);
		await expect(readFile(join(f.root, "workspaces", f.group.id, "snapshot.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("retains a successful side when the other fails and does not report comparison completed", async () => {
		const f = await setup({ run: async (_g, side) => { if (side === "right") throw new Error("fixture failure"); return { text: "success" }; } });
		await f.coordinator.send(f.group.id, "one"); await f.coordinator.settle(f.group.id);
		const { runs } = (await f.coordinator.get(f.group.id)).rounds[0]!;
		expect(runs.left.status).toBe("done"); expect(runs.right).toMatchObject({ status: "error", error: "fixture failure" }); expect(f.completed).not.toHaveBeenCalled();
	});
	it("cancels both sides and waits for their children to settle", async () => {
		const stopped: string[] = [];
		const f = await setup({ run: async (_g, side, _round, signal) => {
			await new Promise<void>((done) => { if (signal.aborted) done(); else signal.addEventListener("abort", () => { stopped.push(side); done(); }, { once: true }); }); return { text: "partial" };
		} });
		await f.coordinator.send(f.group.id, "one"); await f.coordinator.stop(f.group.id);
		expect(stopped.sort()).toEqual(["left", "right"]);
		expect(Object.values((await f.coordinator.get(f.group.id)).rounds[0]!.runs).map((r) => r.status)).toEqual(["aborted", "aborted"]);
	});
	it("restores a persisted running round as interrupted", async () => {
		const f = await setup({ run: async () => ({ text: "unused" }) });
		const g = f.group, run = { status: "running", text: "partial", turnIds: [], startedAt: new Date().toISOString() };
		await writeFile(join(f.root, "groups", `${g.id}.json`), JSON.stringify({ ...g, rounds: [{ id: "r", prompt: "one", runs: { left: run, right: run } }] }));
		const restored = new CompareCoordinator(join(f.root, "groups"), f.workspaces, { run: async () => ({ text: "unused" }) }, vi.fn(), vi.fn());
		expect((await restored.get(g.id)).rounds[0]!.runs.left.status).toBe("interrupted");
	});
	it("deduplicates parent/child turns and does not manufacture unknown metrics or zero-base percentages", () => {
		const parent = { id: "parent", fidelity: { usage: "exact", subagents: true, compaction: true }, usage: { inputTokens: 5, outputTokens: 2 }, events: [{ id: "call", type: "tool.call", name: "read" }, { id: "req", type: "llm.request" }, { id: "child", type: "subagent.start", childTurnId: "child" }] } as TraceTurn;
		const child = { ...parent, id: "child", parentTurnId: "parent", events: [] };
		expect(compareMetrics([parent, child, parent])).toMatchObject({ tokens: 14, toolCalls: 1, modelCalls: 1, subagents: 1 });
		expect(compareMetrics([parent, undefined])).not.toHaveProperty("tokens");
		expect(compareMetrics([{ ...parent, fidelity: { ...parent.fidelity, usage: "partial" } }])).not.toHaveProperty("tokens");
		expect(compareMetrics([{ ...parent, fidelity: { ...parent.fidelity, subagents: false } }])).toMatchObject({ usage: "none" });
		expect(compareMetrics([{ ...parent, fidelity: { ...parent.fidelity, subagents: false } }])).not.toHaveProperty("modelCalls");
		expect(metricDifference(undefined, 2)).toEqual({}); expect(metricDifference(0, 3)).toEqual({ delta: 3 }); expect(metricDifference(2, 3)).toEqual({ delta: 1, percent: 50 });
	});
});
