import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { createApp } from "../src/bootstrap.js";
import type { PiharnessProfile } from "../src/contracts.js";
import { TraceCollector } from "../src/core/trace-collector.js";
import { TraceStore } from "../src/core/trace-store.js";
import type { TraceNotification } from "../src/core/trace.js";
import { loadProfile } from "../src/profile.js";
import { tempWorkspace, writeProfile } from "./helpers.js";

const secret = "sk-test-AAAAAAAAAAAAAAAAAAAA";
const twoTools = `
  fauxAssistantMessage([fauxToolCall("echo", { value: "one" }), fauxToolCall("echo", { value: "two" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("done", { usage: { input: 101, output: 17, cacheRead: 4 } }),
`;

async function fixture(responses = twoTools.repeat(2), recordRawRequests = true) {
	const workspace = await tempWorkspace();
	await writeFile(join(workspace.dir, "model.mjs"), `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 200 }] });
  faux.setResponses([${responses}]);
  ctx.llm.register(faux.provider, "test-model");
  return ctx.tools.register({ name: "echo", label: "Echo", description: "Echo", parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, args) => ({ content: [{ type: "text", text: args.value + " ${secret}" }], details: { authorization: "Bearer unknown-private-key" } })
  });
};
plugin.inject = ["llm", "tools"];
export default plugin;
`);
	const profile: PiharnessProfile = {
		schemaVersion: 1,
		settings: { name: "trace", home: ".data", agent: { provider: "faux", model: "faux-1", systemPrompt: "test", toolExecution: "parallel" } },
		plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "test.model", source: "./model.mjs" }, { id: "runtime.pi" }],
	};
	const app = await createApp(await loadProfile(await writeProfile(workspace.dir, profile)));
	const notifications: TraceNotification[] = [];
	const order: string[] = [];
	const store = new TraceStore(join(workspace.dir, "traces"));
	app.ctx.on("piharness/trace", (notification) => {
		notifications.push(notification);
		order.push(notification.type === "event" ? notification.event.type : notification.type);
		void store.accept(notification);
	});
	app.ctx.on("piharness/agent-event", (_session, event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") order.push("delta");
	});
	return {
		app, workspace, notifications, order, store,
		run: (sessionId?: string) => app.ctx.agents.run("use tools", {
			connection: { provider: "faux", model: "faux-1", apiKey: secret }, recordRawRequests,
			...(sessionId ? { sessionId } : {}),
		}),
		turn: () => (notifications.findLast((item) => item.type === "turn-end") as Extract<TraceNotification, { type: "turn-end" }>).turn,
		close: async () => { await app.stop(); await store.flush(); await workspace.cleanup(); },
	};
}

afterEach(() => vi.restoreAllMocks());

describe("Pi X 光执行链", () => {
	it("reports overflow with compaction disabled and sends untrimmed input to the model", async () => {
		const f = await fixture(`fauxAssistantMessage("model actually accepted the input"),`);
		try {
			const content = "the original input ".repeat(1000);
			const result = await f.app.ctx.agents.run(content, { capabilities: ["core"] });
			expect(result.text).toBe("model actually accepted the input");
			const turn = f.turn();
			expect(turn.events.some((e) => e.type === "context.overflow")).toBe(true);
			expect(turn.events.some((e) => e.type === "context.compacted" || e.type === "context.clipped")).toBe(false);
			expect(turn.usage.modelCalls).toBe(1);
			const request = turn.events.find((e) => e.type === "llm.request")!;
			expect(JSON.stringify(request.raw)).toContain(content);
		} finally { await f.close(); }
	});

	it("retains the provider overflow error instead of replacing it with a fake success", async () => {
		const f = await fixture(`fauxAssistantMessage([], { stopReason: "error", errorMessage: "context length exceeded" }),`);
		try {
			await expect(f.app.ctx.agents.run("long ".repeat(3000), { capabilities: ["core"] })).rejects.toThrow("context length exceeded");
			expect(f.turn().status).toBe("error");
			expect(f.turn().events.some((e) => e.type === "context.overflow")).toBe(true);
		} finally { await f.close(); }
	});

	it("captures two real tools, usage, live ordering, immutable prompts and a restartable redacted turn", async () => {
		const f = await fixture();
		try {
			let renders = 0;
			f.app.ctx.systemPrompt.register({ name: "dynamic", order: 2, source: "workspace", text: () => `dynamic ${++renders}` });
			f.app.ctx.systemPrompt.register({ name: "base", order: 1, source: "base", text: " base " });
			const result = await f.run();
			await f.store.flush();
			expect(result.text).toBe("done");
			expect(renders).toBe(1);
			const turn = f.turn();
			expect(turn.status).toBe("done");
			const requests = turn.events.filter((e) => e.type === "llm.request");
			const responses = turn.events.filter((e) => e.type === "llm.response");
			const calls = turn.events.filter((e) => e.type === "tool.call");
			const results = turn.events.filter((e) => e.type === "tool.result");
			expect(requests).toHaveLength(2);
			expect(responses).toHaveLength(2);
			expect(calls).toHaveLength(2);
			expect(results.map((e) => e.toolCallId).sort()).toEqual(calls.map((e) => e.toolCallId).sort());
			expect(new Set(calls.map((e) => e.parallelGroup))).toEqual(new Set([1]));
			expect(turn.events.filter((e) => e.type === "tool.approval").map((e) => e.decision)).toEqual(["auto-allow", "auto-allow"]);
			expect(turn.usage.modelCalls).toBe(2);
			expect(turn.usage.toolCalls).toBe(2);
			expect(turn.usage.inputTokens).toBe(responses.reduce((sum, e) => sum + e.usage!.input, 0));
			expect(turn.usage.outputTokens).toBe(responses.reduce((sum, e) => sum + e.usage!.output, 0));
			expect(turn.usage.cacheReadTokens).toBe(responses.reduce((sum, e) => sum + e.usage!.cacheRead!, 0));
			expect(turn.usage.cacheWriteTokens).toBe(responses.reduce((sum, e) => sum + e.usage!.cacheWrite!, 0));
			expect(requests.every((request) => request.contextItems !== undefined)).toBe(true);
			expect(requests[1]!.contextItems!.some((item) => item.kind === "tool")).toBe(true);
			expect(requests[1]!.contextItems!.every((item) => !Object.hasOwn(item, "content"))).toBe(true);
			expect(requests[0]!.raw).toMatchObject({ context: { systemPrompt: turn.promptSegments.map((p) => p.text).join("\n\n") } });
			expect(requests[0]!.context.total).toBeGreaterThan(0);
			expect(f.order.indexOf("llm.request")).toBeLessThan(f.order.indexOf("delta"));
			expect(JSON.stringify(f.notifications)).not.toContain(secret);
			expect(JSON.stringify(f.notifications)).not.toContain("unknown-private-key");
			const files = await readdir(join(f.workspace.dir, "traces", "pi"));
			expect(files).toEqual([`${result.sessionId}.jsonl`]);
			const disk = await readFile(join(f.workspace.dir, "traces", "pi", files[0]!), "utf8");
			expect(disk.trim().split("\n")).toHaveLength(1);
			expect(disk).not.toContain(secret);
			const restored = new TraceStore(join(f.workspace.dir, "traces"));
			expect(await restored.turn(turn.id)).toEqual(turn);
			const summaries = await restored.turns("pi", result.sessionId);
			expect(summaries).toHaveLength(1);
			expect(summaries[0]).not.toHaveProperty("events");
			expect(summaries[0]).not.toHaveProperty("promptSegments");
			await f.run(result.sessionId);
			expect(f.turn().turnIndex).toBe(2);
		} finally { await f.close(); }
	});

	it.each(["user", "policy", "cancelled", "timeout"] as const)("preserves %s denial without executing the tool", async (source) => {
		const f = await fixture();
		try {
			f.app.ctx.tools.useGate(() => ({ allow: false, source, reason: "denied" }));
			await f.run();
			expect(f.turn().events.filter((e) => e.type === "tool.approval").map((e) => e.decision)).toEqual(source === "cancelled" || source === "timeout" ? [source, source] : [`${source}-deny`, `${source}-deny`]);
			expect(f.turn().events.filter((e) => e.type === "tool.result").every((e) => e.isError)).toBe(true);
		} finally { await f.close(); }
	});

	it("retains user approval through subsequent policy gates", async () => {
		const f = await fixture();
		try {
			f.app.ctx.tools.useGate(() => ({ allow: true, source: "user" }));
			f.app.ctx.tools.useGate(() => ({ allow: true }));
			await f.run();
			expect(f.turn().events.filter((e) => e.type === "tool.approval").map((e) => e.decision)).toEqual(["user-allow", "user-allow"]);
		} finally { await f.close(); }
	});

	it("omits raw data without changing the conversation or statistics", async () => {
		const f = await fixture(twoTools, false);
		try {
			expect((await f.run()).text).toBe("done");
			expect(f.turn().fidelity.rawRequest).toBe(false);
			expect(f.turn().usage.toolCalls).toBe(2);
			expect(f.turn().events.filter((e) => e.type === "llm.request").every((e) => e.raw === undefined)).toBe(true);
		} finally { await f.close(); }
	});

	it.each(["beginTurn", "event", "endTurn", "wrapStream", "onAgentEvent"] as const)("isolates a throwing collector.%s", async (method) => {
		const f = await fixture();
		try {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.spyOn(TraceCollector.prototype, method).mockImplementation(() => { throw new Error(secret); });
			expect((await f.run()).text).toBe("done");
			expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret);
		} finally { await f.close(); }
	});

	it("ends provider errors truthfully and redacts their trace", async () => {
		const f = await fixture(`fauxAssistantMessage([], { stopReason: "error", errorMessage: "failed ${secret}" }),`);
		try {
			await expect(f.run()).rejects.toThrow("failed [redacted]");
			expect(f.turn().status).toBe("error");
			expect(JSON.stringify(f.turn())).not.toContain(secret);
		} finally { await f.close(); }
	});

	it.each(["aborted", "error"] as const)("does not report the SDK's default zero usage after %s", async (stopReason) => {
		const notifications: TraceNotification[] = [];
		const collector = new TraceCollector((notification) => notifications.push(notification), []);
		const model = fauxProvider({ models: [{ id: "faux-1" }] }).provider.getModels()[0]!;
		collector.beginTurn({ engine: "pi", sessionId: "cancelled", turnIndex: 1, userPrompt: "hi", model: { provider: model.provider, id: model.id }, promptSegments: [],
			fidelity: { promptSegments: true, rawRequest: false, usage: "exact", subagents: true, compaction: true, approvals: true } });
		const stream = createAssistantMessageEventStream();
		const observed = await collector.wrapStream(() => stream, 1000)(model, { messages: [] });
		stream.end(fauxAssistantMessage("partial response", { stopReason }));
		await observed.result();
		collector.endTurn(stopReason);
		const ended = notifications.findLast((notification) => notification.type === "turn-end")!;
		if (ended.type !== "turn-end") throw new Error("Missing completed trace");
		expect(ended.turn.fidelity.usage).toBe("none");
		expect(ended.turn.events.find((event) => event.type === "llm.response")?.usage).toBeUndefined();
	});

	it("marks cancellation separately from model errors", async () => {
		const f = await fixture();
		try {
			f.app.ctx.on("piharness/agent-event", (sessionId, event) => {
				if (event.type === "message_start") f.app.ctx.agents.abort(sessionId);
			});
			await expect(f.run()).rejects.toThrow(/abort/i);
			expect(f.turn().status).toBe("aborted");
		} finally { await f.close(); }
	});

	it("records compaction and its model call when a small context fills", async () => {
		const f = await fixture(`fauxAssistantMessage("brief summary"), fauxAssistantMessage("done"),`);
		try {
			const id = await f.app.ctx.sessions.create();
			const lease = await f.app.ctx.sessions.acquire(id);
			await lease.append("user/message", { message: { role: "user", content: "very long history ".repeat(500), timestamp: 1 } });
			await lease.append("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "old response" }], timestamp: 2 } });
			await lease.release();
			await f.run(id);
			expect(f.turn().events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "context.compacted", tokensBefore: expect.any(Number) })]));
			expect(f.turn().usage.modelCalls).toBe(2);
		} finally { await f.close(); }
	});
});
