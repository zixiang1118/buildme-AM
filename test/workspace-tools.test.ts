import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { ToolRegistry, type ToolExecutionScope } from "../src/core/tool-registry.js";
import { permissionModePolicy, workspaceToolsPi } from "../src/plugins/workspace-tools.js";
import { initProfile, loadProfile } from "../src/profile.js";

import { tempWorkspace } from "./helpers.js";

async function setup(): Promise<Context> {
	const ctx = new Context();
	await ctx.plugin((pluginCtx) => void new ToolRegistry(pluginCtx));
	await ctx.plugin(workspaceToolsPi);
	await ctx.plugin(permissionModePolicy);
	return ctx;
}

function namedTool(ctx: Context, name: string, scope: ToolExecutionScope): AgentTool {
	const tool = ctx.tools.list(scope).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool;
}

describe("Pi workspace tools and permission plugin", () => {
	it.each(["cancelled", "timeout"] as const)("preserves the %s approval outcome without granting access", async (decision) => {
		const fixture = await tempWorkspace(); const ctx = await setup();
		const off = ctx.on("piharness/tool-approval-request", () => ({ decision }));
		try {
			const result = await ctx.tools.authorize({ sessionId: "s", toolCallId: "t", toolName: "bash", args: { command: "true" }, workspacePath: fixture.dir, permissionMode: "ask" });
			expect(result).toMatchObject({ allow: false, source: decision });
		} finally { off(); await ctx.fiber.dispose(); await fixture.cleanup(); }
	});

	it("executes a Pi-native write through the complete DSH AgentFactory and approval path", async () => {
		const fixture = await tempWorkspace();
		try {
			const profileDir = join(fixture.dir, "profile");
			const selectedWorkspace = join(fixture.dir, "selected-workspace");
			await Promise.all([initProfile(profileDir, "workspace-e2e"), mkdir(selectedWorkspace)]);
			await writeFile(join(fixture.dir, "faux-workspace.mjs"), `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "workspace-faux", models: [{ id: "workspace-model" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "created-by-agent.txt", content: "vertical-slice-ok\\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("workspace write finished"),
  ]);
  return ctx.llm.register(faux.provider, "workspace-faux");
};
plugin.inject = ["llm"];
export default plugin;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- id: settings
  config:
    name: workspace-e2e
    home: .
    agent:
      provider: workspace-faux
      model: workspace-model
      systemPrompt: Use the requested tool.
      thinkingLevel: off
      toolExecution: sequential
- insert:
    - id: workspace-faux
      name: ../faux-workspace.mjs
`);

			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			const approvals: string[] = [];
			const off = app.ctx.on("piharness/tool-approval-request", (request) => {
				approvals.push(request.toolName);
				return true;
			});
			try {
				const result = await app.ctx.agents.run("Create the file now.", {
					workspacePath: selectedWorkspace,
					permissionMode: "ask",
				});
				expect(result.text).toBe("workspace write finished");
				expect(approvals).toEqual(["write"]);
				expect(await readFile(join(selectedWorkspace, "created-by-agent.txt"), "utf8")).toBe("vertical-slice-ok\n");
			} finally {
				off();
				await app.stop();
			}
		} finally {
			await fixture.cleanup();
		}
	});

	it("runs Pi native write, read, edit, and bash tools in the selected workspace", async () => {
		const fixture = await tempWorkspace();
		const ctx = await setup();
		const scope: ToolExecutionScope = { workspacePath: fixture.dir, permissionMode: "bypass" };
		try {
			const write = namedTool(ctx, "write", scope);
			const read = namedTool(ctx, "read", scope);
			const edit = namedTool(ctx, "edit", scope);
			const bash = namedTool(ctx, "bash", scope);

			await write.execute("write-1", { path: "notes/item.txt", content: "alpha\n" });
			expect(await readFile(join(fixture.dir, "notes/item.txt"), "utf8")).toBe("alpha\n");
			const readResult = await read.execute("read-1", { path: "notes/item.txt" });
			expect(readResult.content[0]).toMatchObject({ type: "text", text: "alpha\n" });

			await edit.execute("edit-1", {
				path: "notes/item.txt",
				edits: [{ oldText: "alpha", newText: "beta" }],
			});
			expect(await readFile(join(fixture.dir, "notes/item.txt"), "utf8")).toBe("beta\n");

			const bashResult = await bash.execute("bash-1", { command: process.platform === "win32" ? "pwd -W && printf shell-ok" : "pwd && printf shell-ok", timeout: 5 });
			expect(bashResult.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").replaceAll("\\", "/")).toContain(fixture.dir.replaceAll("\\", "/"));
			expect(JSON.stringify(bashResult.content)).toContain("shell-ok");
		} finally {
			await ctx.fiber.dispose();
			await fixture.cleanup();
		}
	});

	it("contains workspace-write paths even through a symlink", async () => {
		const fixture = await tempWorkspace();
		const outside = await tempWorkspace();
		const ctx = await setup();
		try {
			await mkdir(join(fixture.dir, "inside"));
			await symlink(outside.dir, join(fixture.dir, "escape"), process.platform === "win32" ? "junction" : "dir");
			const inside = await ctx.tools.authorize({
				sessionId: "s1",
				toolCallId: "t1",
				toolName: "write",
				args: { path: "inside/ok.txt", content: "ok" },
				workspacePath: fixture.dir,
				permissionMode: "workspace-write",
			});
			const escaped = await ctx.tools.authorize({
				sessionId: "s1",
				toolCallId: "t2",
				toolName: "write",
				args: { path: "escape/pwned.txt", content: "no" },
				workspacePath: fixture.dir,
				permissionMode: "workspace-write",
			});
			expect(inside).toEqual({ allow: true });
			expect(escaped).toMatchObject({ allow: false });
		} finally {
			await ctx.fiber.dispose();
			await Promise.all([fixture.cleanup(), outside.cleanup()]);
		}
	});

	it("routes ask decisions through Cordis and skips every approval in bypass mode", async () => {
		const fixture = await tempWorkspace();
		const ctx = await setup();
		const requests: string[] = [];
		const off = ctx.on("piharness/tool-approval-request", async (request) => {
			requests.push(request.toolName);
			return request.toolName === "write" ? true : { decision: "deny" };
		});
		try {
			const approved = await ctx.tools.authorize({
				sessionId: "s2",
				toolCallId: "t3",
				toolName: "write",
				args: { path: "approved.txt", content: "yes" },
				workspacePath: fixture.dir,
				permissionMode: "ask",
			});
			const denied = await ctx.tools.authorize({
				sessionId: "s2",
				toolCallId: "t4",
				toolName: "bash",
				args: { command: "true" },
				workspacePath: fixture.dir,
				permissionMode: "ask",
			});
			const bypassed = await ctx.tools.authorize({
				sessionId: "s2",
				toolCallId: "t5",
				toolName: "bash",
				args: { command: "true" },
				workspacePath: fixture.dir,
				permissionMode: "bypass",
			});
			expect(approved).toEqual({ allow: true, source: "user" });
			expect(denied).toMatchObject({ allow: false, source: "user" });
			expect(bypassed).toEqual({ allow: true });
			expect(requests).toEqual(["write", "bash"]);
		} finally {
			off();
			await ctx.fiber.dispose();
			await fixture.cleanup();
		}
	});
});
