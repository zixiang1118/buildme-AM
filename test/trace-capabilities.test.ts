import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/bootstrap.js";
import type { PiharnessProfile } from "../src/contracts.js";
import { TraceCollector } from "../src/core/trace-collector.js";
import { TraceStore } from "../src/core/trace-store.js";
import type { TraceNotification, TraceTurn } from "../src/core/trace.js";
import { loadProfile } from "../src/profile.js";
import { tempWorkspace, writeProfile } from "./helpers.js";

const secret = "sk-test-AAAAAAAAAAAAAAAAAAAA";

async function fixture() {
	const workspace = await tempWorkspace();
	await writeFile(join(workspace.dir, "model.mjs"), `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200000, maxTokens: 2000 }] });
  const respond = (context) => {
    const prompt = JSON.stringify(context.messages[0].content);
    const results = context.messages.filter((message) => message.role === "toolResult");
    const isParent = context.tools.some((tool) => tool.name === "delegate_task");
    if (!isParent) {
      if (prompt.includes("fail")) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "child failed ${secret}" });
      if (!results.length) return fauxAssistantMessage(fauxToolCall("echo", { value: prompt }), { stopReason: "toolUse" });
      return fauxAssistantMessage("child result " + prompt + " ${secret}", { usage: { input: 11, output: 7, cacheRead: 0 } });
    }
    if (prompt.includes("skill")) {
      if (!results.length) return fauxAssistantMessage(fauxToolCall("skill_catalog", {}), { stopReason: "toolUse" });
      if (results.length === 1) return fauxAssistantMessage(fauxToolCall("skill_load", { name: prompt.includes("missing") ? "does-not-exist" : "trace-skill" }), { stopReason: "toolUse" });
    } else if (!results.length) {
      if (prompt.includes("parallel")) return fauxAssistantMessage([
        fauxToolCall("delegate_task", { prompt: "child alpha" }), fauxToolCall("delegate_task", { prompt: "child beta" })
      ], { stopReason: "toolUse" });
      if (prompt.includes("two-workflows")) return fauxAssistantMessage([
        fauxToolCall("workflow_run", { steps: ["flow A1", "flow A2"] }),
        fauxToolCall("workflow_run", { steps: ["flow B1", "flow B2"] })
      ], { stopReason: "toolUse" });
      if (prompt.includes("workflow")) return fauxAssistantMessage(fauxToolCall("workflow_run", {
        steps: prompt.includes("fail") ? ["step one", "fail step", "never start"] : ["step one", "never start after cancel"]
      }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall("delegate_task", { prompt: prompt.includes("fail") ? "fail child" : "child task" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("parent done", { usage: { input: 23, output: 5, cacheRead: 0 } });
  };
  faux.setResponses(Array.from({ length: 30 }, () => respond));
  ctx.llm.register(faux.provider, "test-model");
  return ctx.tools.register({ name: "echo", label: "Echo", description: "Echo", parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, args) => ({ content: [{ type: "text", text: args.value + " ${secret}" }], details: {} })
  });
};
plugin.inject = ["llm", "tools"];
export default plugin;
`);
	const profile: PiharnessProfile = {
		schemaVersion: 1,
		settings: { name: "trace-capabilities", home: ".data", agent: { provider: "faux", model: "faux-1", systemPrompt: "test", toolExecution: "parallel" } },
		plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "test.model", source: "./model.mjs" }, { id: "tool.full-edition-tools" }, { id: "runtime.pi" }],
	};
	const app = await createApp(await loadProfile(await writeProfile(workspace.dir, profile)));
	const notifications: TraceNotification[] = [];
	const root = join(workspace.dir, "traces");
	const store = new TraceStore(root);
	app.ctx.on("piharness/trace", (notification) => { notifications.push(notification); void store.accept(notification); });
	return {
		app, workspace, notifications, store, root,
		run: (prompt: string, recordRawRequests = true, capabilities?: readonly string[]) => app.ctx.agents.run(prompt, {
			connection: { provider: "faux", model: "faux-1", apiKey: secret },
			workspacePath: workspace.dir, permissionMode: "bypass", edition: "full", recordRawRequests, ...(capabilities === undefined ? {} : { capabilities }),
		}),
		turns: () => notifications.filter((item): item is Extract<TraceNotification, { type: "turn-end" }> => item.type === "turn-end").map((item) => item.turn),
		close: async () => { await app.stop(); await store.flush(); await workspace.cleanup(); },
	};
}

function ownUsage(turn: TraceTurn) {
	return turn.events.filter((event) => event.type === "llm.response").reduce((sum, event) => sum + event.usage!.input, 0);
}

afterEach(() => vi.restoreAllMocks());

describe("Pi 能力事件与父子回合", () => {
	it("passes the immutable comparison policy to children and denies unconfined child tools", async () => {
		const f = await fixture();
		try {
			const list = vi.spyOn(f.app.ctx.tools, "list");
			const policy = { workspaceRoot: f.workspace.dir, readOnly: true };
			await f.app.ctx.agents.run("delegate", { connection: { provider: "faux", model: "faux-1" }, workspacePath: f.workspace.dir, edition: "full", capabilities: ["core", "subagents"], comparePolicy: policy, compareGroupId: "group" });
			const child = f.turns().find(turn => turn.parentTurnId)!;
			expect(child.compareGroupId).toBe("group");
			expect(child.events.filter(e => e.type === "tool.approval").map(e => e.decision)).toEqual(["policy-deny"]);
			expect(list.mock.calls.filter(([scope]) => scope?.comparePolicy).length).toBeGreaterThanOrEqual(2);
			for (const [scope] of list.mock.calls) if (scope?.comparePolicy) { expect(scope.comparePolicy).toEqual(policy); expect(Object.isFrozen(scope.comparePolicy)).toBe(true); }
		} finally { await f.close(); }
	});
	it("inherits the parent snapshot into child tools while forbidding further delegation", async () => {
		const f = await fixture();
		try {
			await f.run("delegate", true, ["core", "web", "skills", "subagents", "workflow"]);
			const child = f.turns().find((turn) => turn.parentTurnId)!;
			expect(child.capabilities).toEqual(["core", "web", "skills"]);
			const tools = child.events.find((event) => event.type === "llm.request")!.toolNames;
			expect(tools).toEqual(expect.arrayContaining(["web_fetch", "skill_load", "skill_catalog"]));
			expect(tools).not.toContain("delegate_task");
			expect(tools).not.toContain("workflow_run");
			expect(tools).not.toContain("todo_manage");
		} finally { await f.close(); }
	});
	it("links parallel children to their own tool calls, persists their traces and keeps usage separate", async () => {
		const f = await fixture();
		try {
			expect((await f.run("parallel children")).text).toBe("parent done");
			await f.store.flush();
			const turns = f.turns();
			const parent = turns.find((turn) => !turn.parentTurnId)!;
			const children = turns.filter((turn) => turn.parentTurnId === parent.id);
			expect(children).toHaveLength(2);
			expect(new Set(children.map((turn) => turn.sessionId)).size).toBe(2);
			expect(parent.fidelity.subagents).toBe(true);
			const starts = parent.events.filter((event) => event.type === "subagent.start");
			const ends = parent.events.filter((event) => event.type === "subagent.end");
			expect(starts).toHaveLength(2);
			expect(ends).toHaveLength(2);
			const restored = new TraceStore(f.root);
			for (const child of children) {
				expect(starts.find((event) => event.childTurnId === child.id)).toMatchObject({ toolCallId: child.parentToolCallId, task: child.userPrompt, kind: "delegate_task" });
				expect(ends.find((event) => event.childTurnId === child.id)).toMatchObject({ toolCallId: child.parentToolCallId, isError: false });
				expect(child.usage.modelCalls).toBe(2);
				expect(child.usage.toolCalls).toBe(1);
				expect(child.usage.inputTokens).toBe(ownUsage(child));
				expect(await restored.turn(child.id)).toEqual(child);
				const requests = child.events.filter((event) => event.type === "llm.request");
				expect(requests[0]!.messageCount).toBe(1);
				expect(requests[0]!.toolNames).not.toContain("delegate_task");
			}
			expect(parent.usage.modelCalls).toBe(2);
			expect(parent.usage.inputTokens).toBe(ownUsage(parent));
			expect(JSON.stringify(f.notifications)).not.toContain(secret);
			for (const file of await readdir(join(f.root, "pi"))) expect(await readFile(join(f.root, "pi", file), "utf8")).not.toContain(secret);
		} finally { await f.close(); }
	});

	it("inherits raw recording preferences in children", async () => {
		const f = await fixture();
		try {
			await f.run("delegate", false);
			expect(f.turns()).toHaveLength(2);
			for (const turn of f.turns()) {
				expect(turn.fidelity.rawRequest).toBe(false);
				expect(turn.events.filter((event) => event.type === "llm.request").every((event) => event.raw === undefined)).toBe(true);
			}
		} finally { await f.close(); }
	});

	it("records a child error while the parent recovers from the failed tool", async () => {
		const f = await fixture();
		try {
			expect((await f.run("fail delegate")).text).toBe("parent done");
			const child = f.turns().find((turn) => turn.parentTurnId)!;
			const parent = f.turns().find((turn) => !turn.parentTurnId)!;
			expect(child.status).toBe("error");
			expect(parent.status).toBe("done");
			expect(parent.events.find((event) => event.type === "subagent.end")).toMatchObject({ childTurnId: child.id, isError: true });
			expect(parent.events.find((event) => event.type === "tool.result")).toMatchObject({ isError: true });
			expect(JSON.stringify(f.notifications)).not.toContain(secret);
		} finally { await f.close(); }
	});

	it("separates interleaved workflow steps by tool call and links each child", async () => {
		const f = await fixture();
		try {
			await f.run("two-workflows");
			const parent = f.turns().find((turn) => !turn.parentTurnId)!;
			const calls = parent.events.filter((event) => event.type === "tool.call");
			expect(calls).toHaveLength(2);
			for (const call of calls) {
				const steps = parent.events.filter((event) => event.type === "workflow.step").filter((event) => event.toolCallId === call.toolCallId);
				expect(steps.map((step) => [step.stepIndex, step.status])).toEqual([[1, "start"], [1, "end"], [2, "start"], [2, "end"]]);
				const starts = parent.events.filter((event) => event.type === "subagent.start").filter((event) => event.toolCallId === call.toolCallId);
				expect(starts.map((event) => event.stepIndex)).toEqual([1, 2]);
			}
			expect(f.turns().filter((turn) => turn.parentTurnId)).toHaveLength(4);
		} finally { await f.close(); }
	});

	it("stops a failed workflow at its failing step and reports its state", async () => {
		const f = await fixture();
		try {
			await f.run("fail workflow");
			const parent = f.turns().find((turn) => !turn.parentTurnId)!;
			const steps = parent.events.filter((event) => event.type === "workflow.step");
			expect(steps.map((step) => [step.stepIndex, step.status])).toEqual([[1, "start"], [1, "end"], [2, "start"], [2, "error"]]);
			expect(f.turns().filter((turn) => turn.parentTurnId)).toHaveLength(2);
		} finally { await f.close(); }
	});

	it("cancels a running child with its parent and never starts the next workflow step", async () => {
		const f = await fixture();
		try {
			let parentSession = "";
			let childSession = "";
			f.app.ctx.on("piharness/trace", (notification) => {
				if (notification.type !== "turn-start") return;
				if (notification.turn.parentTurnId) childSession = notification.turn.sessionId;
				else parentSession = notification.turn.sessionId;
			});
			f.app.ctx.on("piharness/agent-event", (sessionId, event) => {
				if (sessionId === childSession && event.type === "message_start") f.app.ctx.agents.abort(parentSession);
			});
			await expect(f.run("cancel workflow")).rejects.toThrow(/abort/i);
			expect(f.turns()).toHaveLength(2);
			expect(f.turns().every((turn) => turn.status === "aborted")).toBe(true);
			const parent = f.turns().find((turn) => !turn.parentTurnId)!;
			expect(parent.events.filter((event) => event.type === "workflow.step").map((step) => [step.stepIndex, step.status])).toEqual([[1, "start"], [1, "error"]]);
			expect(f.app.ctx.agents.list()).toHaveLength(0);
		} finally { await f.close(); }
	});

	it("records successful skill discovery and loading from the actual workspace", async () => {
		const f = await fixture();
		try {
			const directory = join(f.workspace.dir, ".buildme", "skills", "trace-skill");
			await mkdir(directory, { recursive: true });
			const content = `---\nname: trace-skill\ndescription: 本地验证技能 ${secret}\n---\n按步骤检查。`;
			const path = join(directory, "SKILL.md");
			await writeFile(path, content);
			await f.run("use skill");
			const parent = f.turns()[0]!;
			expect(parent.events.find((event) => event.type === "skill.catalog")).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ name: "trace-skill", builtin: false })]) });
			expect(parent.events.find((event) => event.type === "skill.load")).toMatchObject({ name: "trace-skill", path, chars: content.length, builtin: false });
			for (const event of parent.events.filter((item) => item.type === "skill.catalog" || item.type === "skill.load")) {
				expect(parent.events.some((call) => call.type === "tool.call" && call.toolCallId === event.toolCallId)).toBe(true);
			}
			expect(JSON.stringify(f.notifications)).not.toContain(secret);
		} finally { await f.close(); }
	});

	it("does not report a skill as loaded when the file cannot be found", async () => {
		const f = await fixture();
		try {
			await f.run("missing skill");
			expect(f.turns()[0]!.events.some((event) => event.type === "skill.load")).toBe(false);
			expect(f.turns()[0]!.events).toContainEqual(expect.objectContaining({ type: "tool.result", isError: true }));
		} finally { await f.close(); }
	});

	it("continues delegation when capability event collection throws", async () => {
		const f = await fixture();
		try {
			const original = TraceCollector.prototype.event;
			vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.spyOn(TraceCollector.prototype, "event").mockImplementation(function (this: TraceCollector, event) {
				if (event.type.startsWith("subagent.") || event.type === "workflow.step") throw new Error(secret);
				return original.call(this, event);
			});
			expect((await f.run("workflow")).text).toBe("parent done");
			expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret);
		} finally { await f.close(); }
	});
});
