import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ExplanationService, eventExplanation, comparisonExplanation, type ExplanationInput, type ExplanationTarget } from "../src/core/explanations.js";
import type { TraceTurn } from "../src/core/trace.js";
import type { CompareGroup } from "../src/core/compare-coordinator.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const target: ExplanationTarget = { kind: "event", turnId: "turn", eventId: "event" };
const secret = "sk-test-AAAAAAAAAAAAAAAAAAAA";
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "buildme-explain-")); roots.push(root);
	const faux = createFauxCore({ provider: "faux", tokensPerSecond: Infinity, tokenSize: { min: 5, max: 5 }, models: [{ id: "local" }] });
	const stream = vi.fn(faux.streamSimple), notify = vi.fn(), completed = vi.fn(async () => {});
	const selected = { connection: { provider: "faux", model: "local", apiKey: secret }, resolved: { model: faux.getModel(), stream } };
	let input: ExplanationInput = { kind: "event", data: { value: secret, usage: { inputTokens: 3 } }, contentHash: "content", turnId: "turn" };
	const create = (version = "1") => new ExplanationService(root, async () => selected, async () => input, notify, completed, version);
	return { root, faux, stream, notify, completed, selected, create, setInput: (value: ExplanationInput) => { input = value; } };
}
describe("independent explanations", () => {
	it("streams bounded, redacted, tool-free input and caches successful output across restart", async () => {
		const f = await fixture(); f.faux.setResponses([fauxAssistantMessage("机制说明。".repeat(100) + secret)]);
		const service = f.create(); service.start("one", target); await service.settle("one");
		expect(f.stream).toHaveBeenCalledOnce();
		const [, context, options] = f.stream.mock.calls[0]!;
		expect(context.tools).toBeUndefined(); expect(context.messages).toHaveLength(1); expect(options).toMatchObject({ maxTokens: 900 });
		expect(JSON.stringify(context)).not.toContain(secret); expect(JSON.stringify(f.notify.mock.calls)).not.toContain(secret);
		expect(JSON.stringify(f.notify.mock.calls)).not.toContain(secret.slice(0, 10));
		expect(f.notify.mock.calls.some(([event]) => event.type === "text")).toBe(true);
		expect(f.notify.mock.calls.at(-1)![0]).toMatchObject({ type: "done", cached: false });
		const restored = f.create(); restored.start("two", target); await restored.settle("two");
		expect(f.stream).toHaveBeenCalledOnce(); expect(f.notify.mock.calls.at(-1)![0]).toMatchObject({ type: "done", cached: true });
		const files = await readdir(f.root); expect(files).toHaveLength(1); expect(await readFile(join(f.root, files[0]!), "utf8")).not.toContain(secret);
	});
	it("keys the cache by model, content and explanation version without storing credentials", async () => {
		const f = await fixture(); f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("解释完成")));
		let service = f.create(); service.start("a", target); await service.settle("a");
		f.selected.connection.model = "different"; service.start("b", target); await service.settle("b");
		f.setInput({ kind: "event", data: { changed: true }, contentHash: "changed" }); service.start("c", target); await service.settle("c");
		service = f.create("2"); service.start("d", target); await service.settle("d");
		expect(f.stream).toHaveBeenCalledTimes(4); expect(await readdir(f.root)).toHaveLength(4);
	});
	it.each(["error", "length"] as const)("does not cache or unlock on %s", async (stopReason) => {
		const f = await fixture(); f.faux.setResponses([fauxAssistantMessage("未完成", { stopReason, errorMessage: `failure ${secret}` })]);
		const service = f.create(); service.start("one", target); await service.settle("one");
		expect(f.notify.mock.calls.at(-1)![0]).toMatchObject({ type: "error" }); expect(JSON.stringify(f.notify.mock.calls)).not.toContain(secret);
		expect(f.completed).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
	});
	it("cancels a pending request, does not cache it and reports a missing record explicitly", async () => {
		const f = await fixture(); let entered!: () => void; const ready = new Promise<void>((done) => { entered = done; });
		f.faux.setResponses([async (_context, options) => {
			entered(); await new Promise<void>((done) => options!.signal!.addEventListener("abort", () => done(), { once: true }));
			return fauxAssistantMessage("partial", { stopReason: "aborted" });
		}]);
		const service = f.create(); service.start("cancel", target); await ready; await service.cancel("cancel");
		expect(f.notify.mock.calls.at(-1)![0]).toMatchObject({ type: "cancelled" }); expect(await readdir(f.root)).toEqual([]); expect(f.completed).not.toHaveBeenCalled();
		const missing = new ExplanationService(f.root, async () => f.selected, async () => { throw new Error("记录已清理"); }, f.notify, f.completed);
		missing.start("missing", target); await missing.settle("missing"); expect(f.notify.mock.calls.at(-1)![0]).toMatchObject({ type: "error", message: "记录已清理" });
	});
	it("selects only the requested event or prompt, bounds it to 8 KB, and excludes chat and other events", () => {
		const turn = { id: "turn", userPrompt: "PRIVATE_CHAT", finalAnswer: "PRIVATE_ANSWER", usage: {}, fidelity: {}, promptSegments: [{ text: "prompt", name: "base" }], events: [{ id: "event", type: "tool.call", name: "read", args: { content: "中文".repeat(9000) } }, { id: "other", type: "error", message: "PRIVATE_OTHER_EVENT" }] } as TraceTurn;
		const value = eventExplanation(turn, target, { topics: { "tool.call": { what: "工具调用" } } });
		expect(Buffer.byteLength(JSON.stringify(value.data))).toBeLessThan(9000); expect(JSON.stringify(value.data)).not.toContain("PRIVATE");
		expect(value.data).toMatchObject({ event: { truncated: true } });
		expect(() => eventExplanation(turn, { ...target, eventId: "missing" }, { topics: {} })).toThrow("不存在");
		expect(eventExplanation(turn, { kind: "event", turnId: "turn", segmentIndex: 0 }, { topics: {} }).data).toMatchObject({ event: { text: JSON.stringify(turn.promptSegments[0]) } });
	});
	it("summarizes only counts and model identities, never chat, args, file paths, raw data or answers", () => {
		const run = { status: "done", text: "PRIVATE_ANSWER", turnIds: ["turn"] }, side = { engine: "pi", connection: { model: "local", apiKey: secret } };
		const group = { kind: "model", title: "PRIVATE_CHAT", sides: { left: side, right: side }, rounds: [{ prompt: "PRIVATE_CHAT", runs: { left: run, right: run } }], differences: { left: { changes: [{ kind: "added", path: "PRIVATE_PATH", diff: "PRIVATE_DIFF" }] } } } as unknown as CompareGroup;
		const turn = { id: "turn", events: [{ id: "event", type: "tool.call", name: "read", args: { key: secret } }] } as TraceTurn;
		const result = comparisonExplanation(group, { left: { tools: ["read"], toolCalls: 1, usage: "exact" }, right: { tools: [], usage: "none" } }, { left: [turn, turn], right: [] });
		expect(JSON.stringify(result)).not.toMatch(/PRIVATE|sk-test|apiKey/u);
		expect(result.data).toMatchObject({ sides: { left: { eventCounts: { "tool.call": 1 }, fileChanges: { added: 1 } }, right: { metrics: { usage: "none" } } } });
	});
});
