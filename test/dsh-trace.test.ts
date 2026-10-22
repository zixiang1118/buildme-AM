import { describe, expect, it } from "vitest";
import { DshTraceRecorder } from "../src/full/dsh-trace.js";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { TraceNotification, TraceTurn } from "../src/core/trace.js";

function fixture(publish?: (n: TraceNotification) => void) {
	const notifications: TraceNotification[] = [];
	const recorder = new DshTraceRecorder(publish ?? ((n) => notifications.push(n)), ["fixture-secret"]);
	const sessions = new Map<string, ReturnType<typeof session>>();
	function session(id: string, parentSession?: string) {
		const events: { type: string; seq: number; time: number; data: Record<string, unknown> }[] = [];
		return { id, seq: 0, header: parentSession ? { parentSession } : {}, eventAt: (seq: number) => events[seq], events };
	}
	function emit(id: string, type: string, data: Record<string, unknown>, parent?: string) {
		if (!sessions.has(id)) sessions.set(id, session(id, parent));
		const s = sessions.get(id)!;
		const event = { type, seq: s.seq++, time: Date.now(), data };
		s.events.push(event); recorder.sessionEvent(s, event);
	}
	const start = (id = "root", parent?: string) => { recorder.configure(id, { provider: "fake", model: "model", text: "input", compareGroupId: "group" }); emit(id, "turn/start", { turn: 1 }, parent); emit(id, "user/message", { content: [{ type: "text", text: `input-${id}` }], source: { kind: "user" } }); };
	const end = (id = "root", kind = "completed") => emit(id, "turn/end", { reason: { kind } });
	const turns = () => notifications.filter((n): n is { type: "turn-end"; turn: TraceTurn } => n.type === "turn-end").map((n) => n.turn);
	async function stream(id = "root", chunks: StreamChunk[] = [{ type: "usage", usage: { inputTokens: 10, outputTokens: 4 } }]) {
		const options = { provider: "fake", model: "actual-model", sessionId: id, messages: [{ role: "user", source: {kind:"user"}, content: [{ type: "text", text: "fixture-secret" }] }] } as GenerateOptions;
		const received = [];
		for await (const chunk of recorder.stream(options, async function* () { yield* chunks; })) received.push(chunk);
		expect(received).toEqual(chunks);
	}
	return { recorder, notifications, sessions, emit, start, end, turns, stream };
}

describe("DSH Trace actual observation contracts", () => {
	it("records input, answer, adapter input, model and real usage; backfill does not duplicate", async () => {
		const f = fixture(); f.start(); await f.stream();
		f.emit("root", "assistant/message", { message: { content: [{ type: "text", text: "answer fixture-secret" }] } }); f.end();
		f.recorder.backfill(f.sessions.get("root")!, 0);
		expect(f.turns()).toHaveLength(1);
		const turn = f.turns()[0]!;
		expect(turn).toMatchObject({ userPrompt: "input-root", finalAnswer: "answer «已隐藏»", model: { id: "actual-model" }, compareGroupId: "group", fidelity: { usage: "exact", promptSegments: false }, usage: { modelCalls: 1, inputTokens: 10, outputTokens: 4 } });
		expect(JSON.stringify(f.notifications)).not.toContain("fixture-secret");
		expect(turn.events).toHaveLength(2);
	});
	it("keeps reported usage when a later request is cancelled, without presenting a complete total", async () => {
		const f = fixture(); f.start(); await f.stream(); await f.stream("root", []); f.end();
		expect(f.turns()[0]!.fidelity.usage).toBe("partial");
		expect(f.turns()[0]!.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, reportedCalls: 1, missingCalls: 1 });
		expect(f.turns()[0]!.usage.modelCalls).toBe(2);
	});
	it("keeps all-missing usage unknown and captures only supplied reasoning with redaction", async () => {
		const f = fixture(); f.start(); await f.stream("root", [{ type: "reasoning-delta", index: 0, text: "检查 fixture-secret" }]); f.end("root", "aborted");
		expect(f.turns()[0]!.fidelity.usage).toBe("none");
		expect(f.turns()[0]!.usage).not.toHaveProperty("inputTokens");
		expect(f.turns()[0]!.events.find(e => e.type === "llm.response")).toMatchObject({ reasoning: "检查 «已隐藏»", reasoningTruncated: false });
	});
	it("separates child tokens and links child ids", async () => {
		const f = fixture(); f.start(); await f.stream(); f.start("child", "root"); await f.stream("child"); f.end("child"); f.end();
		const [child, parent] = f.turns();
		expect(child!.parentTurnId).toBe(parent!.id);
		expect(parent!.usage.inputTokens).toBe(10); expect(child!.usage.inputTokens).toBe(10);
		expect(parent!.events.filter((e) => e.type === "subagent.start")).toHaveLength(1);
	});
	it.each(["user-deny", "cancelled", "timeout"] as const)("preserves %s without turning it into auto approval", (decision) => {
		const f = fixture(); f.start(); f.recorder.toolStart("root", "call", "write", { text: "fixture-secret" });
		f.recorder.approval("root", "call", decision); f.recorder.approval("root", "call", "auto-allow");
		f.recorder.toolResult("root", "call", "write", {}, { isError: true, content: "blocked" });
		f.recorder.toolResult("root", "call", "write", {}, { isError: true, content: "blocked" }); f.end();
		expect(f.turns()[0]!.events.filter((e) => e.type === "tool.approval")).toMatchObject([{ decision }]);
		expect(f.turns()[0]!.usage.toolCalls).toBe(1);
		expect(f.turns()[0]!.events.filter((e) => e.type === "tool.result")).toHaveLength(1);
	});
	it("captures actual compaction and prune events with nonzero observed sizes", () => {
		const f = fixture(); f.start();
		f.emit("root", "compaction/summary", { summary: [{ type: "text", text: "summary" }], shadowedTokenCount: 400, shadowedSeqs: [1] });
		f.emit("root", "compaction/prune", { shadowedSeqs: [1] });
		f.emit("root", "user/message", { content: "short", source: { kind: "compaction" } }); f.end();
		expect(f.turns()[0]!.events).toMatchObject([{ type: "context.compacted", tokensBefore: 400 }, { type: "context.clipped", charsAfter: 7 }]);
		expect(f.turns()[0]!.userPrompt).toBe("input-root");
	});
	it("observer publication failure does not prevent model output", async () => {
		const f = fixture(() => { throw new Error("observer fixture"); }); f.start(); await f.stream(); f.end();
	});
	it.each([['aborted', 'aborted'], ['blocked', 'error'], ['error', 'error'], ['max-tokens', 'done']])("keeps end reason %s", (kind, status) => {
		const f = fixture(); f.start(); f.end("root", kind); expect(f.turns()[0]!.status).toBe(status);
	});
});
