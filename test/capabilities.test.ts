import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES, ALL_CAPABILITIES, childCapabilities, resolveCapabilities, toggleCapability } from "../src/core/capabilities.js";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { SystemPromptRuntime } from "../src/core/prompt-registry.js";
import { CapabilityUsageStore, capabilityUsage } from "../src/core/capability-usage.js";
import { createApp } from "../src/bootstrap.js";
import { loadProfile } from "../src/profile.js";
import type { TraceNotification, TraceTurn } from "../src/core/trace.js";
import { tempWorkspace, writeProfile } from "./helpers.js";

async function fixture() {
	const workspace = await tempWorkspace();
	await writeFile(join(workspace.dir, "model.mjs"), `
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
 const faux = fauxProvider({ provider: "faux", models: [{ id: "caps", contextWindow: 200000, maxTokens: 2000 }] });
 faux.setResponses(Array.from({ length: 30 }, () => () => fauxAssistantMessage("真实的测试响应")));
 return ctx.llm.register(faux.provider, "cap-test");
}; plugin.inject = ["llm"]; export default plugin;
`);
	const prompt = await readFile(new URL("../bundles/base/prompts/buildme-agent.md", import.meta.url), "utf8");
	const app = await createApp(await loadProfile(await writeProfile(workspace.dir, {
		schemaVersion: 1, settings: { name: "caps", home: ".data", agent: { provider: "faux", model: "caps", systemPrompt: prompt } },
		plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "test.model", source: "./model.mjs" }, { id: "prompt.personal" }, { id: "tool.workspace-info" }, { id: "tool.workspace-tools-pi" }, { id: "tool.document-tools" }, { id: "tool.full-edition-tools" }, { id: "runtime.pi" }],
	})));
	const turns: TraceTurn[] = [];
	app.ctx.on("piharness/trace", (notification: TraceNotification) => { if (notification.type === "turn-end") turns.push(notification.turn); });
	return { app, turns, workspace, close: async () => { await app.stop(); await workspace.cleanup(); } };
}

describe("能力配置", () => {
	it("normalizes dependencies without mutating callers and removes delegation from children", () => {
		const source = ["workflow"];
		expect(resolveCapabilities(source)).toEqual(["core", "subagents", "workflow"]);
		expect(source).toEqual(["workflow"]);
		expect(Object.isFrozen(resolveCapabilities(source))).toBe(true);
		expect(toggleCapability(ALL_CAPABILITIES, "subagents", false)).not.toContain("workflow");
		expect(toggleCapability(["core"], "workflow", true)).toEqual(["core", "subagents", "workflow"]);
		expect(() => toggleCapability(ALL_CAPABILITIES, "core", false)).toThrow("不能关闭");
		expect(() => resolveCapabilities(["unknown"])).toThrow("未知能力");
		expect(childCapabilities(ALL_CAPABILITIES)).toEqual(ALL_CAPABILITIES.filter((id) => !["workflow", "subagents"].includes(id)));
	});

	it("preserves legacy editions, third-party registration and permission gates", async () => {
		const ctx = new Context(); const registry = new ToolRegistry(ctx);
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
		for (const [name, edition] of [["read", "standard"], ["web_fetch", "full"], ["custom", "standard"], ["custom_full", "full"]] as const) registry.register({ name, label: name, description: name, parameters: Type.Object({}), execute }, "test", { edition });
		const scope = { workspacePath: "/tmp", permissionMode: "ask" as const };
		expect(registry.list().map((t) => t.name)).toEqual(["custom", "read"]);
		expect(registry.list({ ...scope, edition: "full" }).map((t) => t.name)).toEqual(["custom", "custom_full", "read", "web_fetch"]);
		expect(registry.list({ ...scope, capabilities: resolveCapabilities(["web"]) }).map((t) => t.name)).toEqual(["custom", "read", "web_fetch"]);
		expect(registry.list({ ...scope, edition: "full", capabilities: ["core"] }).map((t) => t.name)).toEqual(["custom", "custom_full", "read"]);
		registry.useGate(() => ({ allow: false, reason: "denied" }));
		expect((await registry.authorize({ sessionId: "test", toolCallId: "test", toolName: "web_fetch", args: {} })).allow).toBe(false);
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not evaluate a disabled Skill catalog and keeps unknown plugin sections", async () => {
		const ctx = new Context(); const prompts = new SystemPromptRuntime(ctx); const catalog = vi.fn(() => "private-skill-catalog");
		prompts.register({ name: "catalog", order: 1, source: "skill-catalog", text: catalog });
		prompts.register({ name: "external", order: 2, capabilityId: "external", text: "plugin" });
		expect(prompts.renderSections(["core"]).map((s) => s.text)).toEqual(["plugin"]);
		expect(catalog).not.toHaveBeenCalled();
		expect(prompts.renderSections(["core", "skills"])[0]!.text).toBe("private-skill-catalog");
		expect(catalog).toHaveBeenCalledOnce();
	});

	it.each(CAPABILITIES.filter(({ id }) => id !== "core"))("filters $id tools and actual request prompt with one snapshot", async (definition) => {
		const f = await fixture();
		try {
			const off = toggleCapability(ALL_CAPABILITIES, definition.id, false);
			for (const capabilities of [off, ALL_CAPABILITIES]) {
				await f.app.ctx.agents.run("检查能力", { capabilities, workspacePath: f.workspace.dir, permissionMode: "bypass" });
				const turn = f.turns.at(-1)!; const request = turn.events.find((e) => e.type === "llm.request")!;
				expect(turn.capabilities).toEqual(capabilities);
				for (const capability of CAPABILITIES) {
					for (const tool of capability.tools) expect(request.toolNames.includes(tool), tool).toBe(capabilities.includes(capability.id));
					for (const section of capability.promptSections) expect(turn.promptSegments.some((p) => p.name === section)).toBe(capabilities.includes(capability.id));
				}
				expect(request.raw).toMatchObject({ context: { systemPrompt: turn.promptSegments.map((p) => p.text).join("\n\n") } });
				expect(turn.promptSegments.filter((p) => p.source === "capability").every((p) => p.sourcePath === `bundles/base/prompts/capabilities/${p.capabilityId}.md`)).toBe(true);
			}
		} finally { await f.close(); }
	});

	it("captures configuration before the first async operation and only changes the next turn", async () => {
		const f = await fixture();
		try {
			const capabilities = ["core", "skills"];
			const pending = f.app.ctx.agents.run("first", { capabilities });
			capabilities.splice(1, 1, "web");
			const result = await pending;
			expect(f.turns[0]!.capabilities).toEqual(["core", "skills"]);
			expect(f.turns[0]!.events.find((e) => e.type === "llm.request")!.toolNames).toContain("skill_load");
			await f.app.ctx.agents.run("second", { capabilities, sessionId: result.sessionId });
			expect(f.turns[1]!.capabilities).toEqual(["core", "web"]);
			expect(f.turns[1]!.events.find((e) => e.type === "llm.request")!.toolNames).not.toContain("skill_load");
		} finally { await f.close(); }
	});

	it("persists real usage exactly once, without counting toggles or denied tools", async () => {
		const f = await fixture();
		try {
			await f.app.ctx.agents.run("hello", { capabilities: ALL_CAPABILITIES });
			const turn = f.turns[0]!;
			expect(Object.values(capabilityUsage(turn)).every((count) => count === 0)).toBe(true);
			turn.events.push(
				{ id: "call", type: "tool.call", at: turn.startedAt, round: 1, name: "web_fetch", args: {}, toolCallId: "t" },
				{ id: "result", type: "tool.result", at: turn.startedAt, toolCallId: "t", isError: false, durationMs: 1, resultPreview: "ok", resultBytes: 2, truncated: false },
				{ id: "clip", type: "context.clipped", at: turn.startedAt, toolCallId: "t", charsBefore: 100, charsAfter: 20 },
			);
			turn.events.push(turn.events.at(-1)!);
			const path = join(f.workspace.dir, "usage.json"); const store = new CapabilityUsageStore(path);
			await Promise.all([store.accept(turn), store.accept(turn)]);
			expect(await store.counts()).toMatchObject({ web: 1, compaction: 1, skills: 0 });
			const restored = new CapabilityUsageStore(path); await restored.accept(turn);
			expect(await restored.counts()).toEqual(await store.counts());
			turn.events.find((e) => e.type === "tool.result")!.isError = true;
			expect(capabilityUsage(turn).web).toBe(0);
			expect(await readFile(path, "utf8")).not.toContain("hello");
		} finally { await f.close(); }
	});
});
