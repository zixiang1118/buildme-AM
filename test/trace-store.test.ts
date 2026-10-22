import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { TraceCollector, TRACE_RAW_BYTES, TRACE_RESULT_BYTES } from "../src/core/trace-collector.js";
import { redactTrace, TRACE_HIDDEN, truncateUtf8 } from "../src/core/trace-redact.js";
import { TraceStore } from "../src/core/trace-store.js";
import { estimateTokens, type TraceNotification, type TraceTurn } from "../src/core/trace.js";
import { tempWorkspace } from "./helpers.js";

function turn(index = 1, sessionId = "session"): TraceTurn {
	return {
		id: `turn-${index}`, sessionId, turnIndex: index, engine: "pi", startedAt: "2026-10-05T00:00:00.000Z", endedAt: "2026-10-05T00:00:01.000Z", status: "done",
		userPrompt: "hello", model: { provider: "faux", id: "faux-1" },
		fidelity: { promptSegments: true, rawRequest: true, usage: "exact", subagents: false, compaction: true, approvals: true },
		promptSegments: [],
		events: [{ type: "llm.request", id: `request-${index}`, at: "2026-10-05T00:00:00.000Z", round: 1, messageCount: 1, toolNames: [],
			context: { systemPrompt: 1, toolDefinitions: 0, userMessages: 1, assistantMessages: 0, toolResults: 0, summary: 0, total: 2, limit: 100 }, raw: { text: "hello" } }],
		usage: { inputTokens: 10, outputTokens: 20, modelCalls: 1, toolCalls: 0, durationMs: 1000 },
	};
}

describe("X 光脱敏与容量", () => {
	it("recovers partial usage from old cancelled history without rewriting the original file", async () => {
		const workspace = await tempWorkspace();
		try {
			const root = join(workspace.dir, "traces"), original = turn();
			Object.assign(original.fidelity, { usage: "none" }); original.status = "aborted";
			original.usage = { modelCalls: 2, toolCalls: 0, durationMs: 1000 };
			original.events.push({ type: "llm.response", id: "reply", at: original.startedAt, round: 1, durationMs: 10, textPreview: "partial", toolCalls: [], usage: { input: 10, output: 2, cacheRead: 4 } }, { ...original.events[0]!, id: "next", round: 2 } as TraceTurn["events"][number]);
			await mkdir(join(root, "pi"), { recursive: true });
			const file = join(root, "pi/session.jsonl"), content = JSON.stringify(original) + "\n";
			await writeFile(file, content);
			const store = new TraceStore(root);
			expect((await store.turn(original.id))!).toMatchObject({ fidelity: { usage: "partial" }, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, reportedCalls: 1, missingCalls: 1 } });
			expect((await store.turns("pi", "session"))[0]!.fidelity.usage).toBe("partial");
			expect(await readFile(file, "utf8")).toBe(content);
		} finally { await workspace.cleanup(); }
	});
	it("redacts known credentials, sensitive fields, header values and key-shaped strings without losing token metrics", () => {
		const source = {
			Authorization: "Bearer header-secret", "x-api-key": "another-key", nested: [{ password: 12345, access_token: "access-value", SECRET: "secret-value" }],
			prompt: "use sk-test-AAAAAAAAAAAAAAAAAAAA and custom-request-key", apiKeyInObjectName: "key-value",
			usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 1 }, tokensBefore: 300,
		};
		const safe = redactTrace(source, ["custom-request-key"]);
		expect(safe.usage).toEqual(source.usage);
		expect(safe.tokensBefore).toBe(300);
		expect(safe.nested[0]!.password).toBe(TRACE_HIDDEN);
		for (const secret of ["header-secret", "another-key", "access-value", "secret-value", "sk-test-AAAAAAAAAAAAAAAAAAAA", "custom-request-key", "key-value"])
			expect(JSON.stringify(safe)).not.toContain(secret);
		expect(source.Authorization).toBe("Bearer header-secret");
	});

	it("redacts environment values and secrets embedded in stringified headers", () => {
		vi.stubEnv("BUILDME_ACTIVE_API_KEY", "ambient-active-key");
		vi.stubEnv("DEEPSEEK_API_KEY", "ambient-ds-key");
		try {
			const text = redactTrace('ambient-active-key ambient-ds-key {"password":"hidden-value"} Authorization: Bearer private-header-key');
			for (const secret of ["ambient-active-key", "ambient-ds-key", "hidden-value", "private-header-key"]) expect(text).not.toContain(secret);
		} finally { vi.unstubAllEnvs(); }
	});

	it("counts CJK and truncates by UTF-8 bytes without replacement characters", () => {
		expect(estimateTokens("中文かな한글abcd")).toBe(7);
		expect(estimateTokens("")).toBe(0);
		expect(truncateUtf8("中🙂文", 6)).toBe("中");
		expect(truncateUtf8("中🙂文", 7)).toBe("中🙂");
	});

	it("bounds raw per turn and retains bounded UTF-8 tool content", () => {
		const notifications: TraceNotification[] = [];
		const collector = new TraceCollector((event) => notifications.push(event), []);
		collector.beginTurn(turn());
		const request = turn().events[0]!;
		if (request.type !== "llm.request") throw new Error("wrong fixture");
		for (let i = 0; i < 4; i += 1) collector.event({ ...request, raw: { text: "原始请求".repeat(200_000) } });
		collector.onAgentEvent({ type: "tool_execution_start", toolCallId: "call", toolName: "echo", args: {} }, "ask", true, []);
		collector.onAgentEvent({ type: "tool_execution_end", toolCallId: "call", toolName: "echo", isError: false, result: { content: [{ type: "text", text: "中文🙂".repeat(10_000) }], details: {} } }, "ask", true, []);
		collector.endTurn("done");
		const ended = notifications.at(-1)!;
		if (ended.type !== "turn-end") throw new Error("missing turn-end");
		const raw = ended.turn.events.filter((e) => e.type === "llm.request");
		expect(raw.reduce((sum, e) => sum + (e.raw === undefined ? 0 : Buffer.byteLength(JSON.stringify(e.raw))), 0)).toBeLessThanOrEqual(TRACE_RAW_BYTES);
		expect(raw.some((e) => e.rawTruncated)).toBe(true);
		const result = ended.turn.events.find((e) => e.type === "tool.result")!;
		expect(Buffer.byteLength(result.resultPreview)).toBeLessThanOrEqual(4096);
		expect(Buffer.byteLength(result.result!)).toBeLessThanOrEqual(TRACE_RESULT_BYTES);
		expect(result.truncated).toBe(true);
		expect(result.result).not.toContain("�");
	});

	it("keeps only the latest 20 turns' raw data, without dropping older statistics or duplicating a turn", async () => {
		const workspace = await tempWorkspace();
		try {
			const store = new TraceStore(join(workspace.dir, "traces"));
			await Promise.all(Array.from({ length: 22 }, (_, i) => store.accept({ type: "turn-end", turn: turn(i + 1) })));
			await store.accept({ type: "turn-end", turn: turn(22) });
			const disk = (await readFile(join(workspace.dir, "traces", "pi", "session.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as TraceTurn);
			expect(disk).toHaveLength(22);
			expect(disk[0]!.usage.modelCalls).toBe(1);
			expect(disk.slice(0, 2).every((t) => t.events[0]!.type === "llm.request" && t.events[0]!.raw === undefined)).toBe(true);
			expect(disk.slice(2).every((t) => t.events[0]!.type === "llm.request" && t.events[0]!.raw !== undefined)).toBe(true);
		} finally { await workspace.cleanup(); }
	});

	it("evicts oldest session files under the shared disk quota", async () => {
		const workspace = await tempWorkspace();
		try {
			const root = join(workspace.dir, "traces");
			const bytes = Buffer.byteLength(JSON.stringify(turn()) + "\n");
			const store = new TraceStore(root, { totalBytes: bytes * 2 + 40, rawTurns: 20 });
			await store.accept({ type: "turn-end", turn: turn(1, "old") });
			await utimes(join(root, "pi", "old.jsonl"), new Date(0), new Date(0));
			await store.accept({ type: "turn-end", turn: turn(2, "new") });
			await store.accept({ type: "turn-end", turn: turn(3, "newest") });
			expect(await readdir(join(root, "pi"))).toEqual(expect.arrayContaining(["new.jsonl", "newest.jsonl"]));
			expect(await store.turn("turn-1")).toBeUndefined();
		} finally { await workspace.cleanup(); }
	});

	it("serves an active turn, then a 200-event turn from a fresh store within 100ms", async () => {
		const workspace = await tempWorkspace();
		try {
			const root = join(workspace.dir, "traces");
			const store = new TraceStore(root);
			const running = { ...turn(), status: "running" as const, events: [], usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 } };
			await store.accept({ type: "turn-start", turn: running });
			await store.accept({ type: "event", turnId: running.id, event: turn().events[0]! });
			expect((await store.turn(running.id))!.usage.modelCalls).toBe(1);
			const ended = turn();
			ended.events = Array.from({ length: 200 }, (_, i) => ({ type: "error", id: `event-${i}`, at: ended.startedAt, message: "example" }));
			await store.accept({ type: "turn-end", turn: ended });
			const fresh = new TraceStore(root);
			const started = performance.now();
			expect((await fresh.turn(ended.id))!.events).toHaveLength(200);
			expect(performance.now() - started).toBeLessThan(100);
			expect(await fresh.turns("dsh", ended.sessionId)).toEqual([]);
			await expect(fresh.turns("pi", "../escape")).rejects.toThrow("标识");
		} finally { await workspace.cleanup(); }
	});

	it("reports write failures and allows later turns to persist", async () => {
		const workspace = await tempWorkspace();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const root = join(workspace.dir, "traces");
			await mkdir(root);
			await writeFile(join(root, "pi"), "occupied");
			const store = new TraceStore(root);
			await store.accept({ type: "turn-end", turn: turn() });
			expect(warning).toHaveBeenCalled();
			await store.accept({ type: "turn-end", turn: { ...turn(2), engine: "dsh" } });
			expect((await store.turn("turn-2"))!.engine).toBe("dsh");
		} finally { warning.mockRestore(); await workspace.cleanup(); }
	});
});
