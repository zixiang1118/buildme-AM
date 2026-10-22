import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { PluginHost } from "../src/plugin-host.js";
import { initProfile, loadProfile } from "../src/profile.js";

import { supportsFileSymlinks, tempWorkspace } from "./helpers.js";

const fileSymlinks = await supportsFileSymlinks();

async function freshProfile(root: string): Promise<string> {
	const profile = join(root, "profile");
	await initProfile(profile, "test");
	return profile;
}

describe("DSH Cordis plugin tree", () => {
	it("mounts the base bundle through Loader/Include and tears down every service", async () => {
		const workspace = await tempWorkspace();
		try {
			const profile = await loadProfile(await freshProfile(workspace.dir), { homePatch: false });
			expect(profile.manifest.bundles).toEqual(["@my-agent/base"]);
			const app = await createApp(profile);
			try {
				const entries = app.host.list();
				expect(entries.map((entry) => entry.entry.id)).toEqual(expect.arrayContaining([
					"settings", "session", "system-prompt", "tools", "llm", "agent", "agent-loop",
				]));
				expect(entries.every((entry) => entry.state === "active")).toBe(true);
				expect(app.ctx.systemPrompt.render()).toContain("你是 BuildMe");
				expect(app.ctx.systemPrompt.render()).not.toContain("Claude Code");
				expect(app.ctx.llm.resolve("deepseek", "deepseek-v4-flash").provider).toBe("deepseek");
				expect(app.ctx.agentLoop).toBeDefined();
			} finally {
				await app.stop();
			}
			expect(app.ctx.get("systemPrompt")).toBeUndefined();
			expect(app.ctx.get("llm")).toBeUndefined();
			expect(app.ctx.get("agents")).toBeUndefined();
		} finally {
			await workspace.cleanup();
		}
	});

	it.runIf(fileSymlinks)("does not create or follow a writable Include carrier inside the profile", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			const victim = join(workspace.dir, "victim.txt");
			await writeFile(victim, "KEEP-THIS-CONTENT\n");
			await symlink("../victim.txt", join(profileDir, ".piharness-cordis-root.yml"));
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			await app.stop();
			expect(await readFile(victim, "utf8")).toBe("KEEP-THIS-CONTENT\n");
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps the profile URL as every mounted plugin context base", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "capture-base.mjs"), `
export default (ctx) => { ctx.provide("captured-base-url", ctx.baseUrl); };
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: capture-base
      name: ../capture-base.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.ctx.get("captured-base-url")).toBe(`${pathToFileURL(profileDir).href}/`);
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns cleanly when a one-shot plugin disposes the root during startup", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "exiting.mjs"), `
export default (ctx) => { void ctx.root.fiber.dispose(); };
`);
			await writeFile(join(workspace.dir, "delayed.mjs"), `
await new Promise((resolve) => setTimeout(resolve, 10));
export default () => undefined;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: exiting
      name: ../exiting.mjs
    - id: delayed
      name: ../delayed.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			expect(app.ctx.get("loader")).toBeUndefined();
			await app.stop();
		} finally {
			await workspace.cleanup();
		}
	});

	it("activates an earlier consumer when its injected service appears later", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "consumer.mjs"), `
const plugin = (ctx) => ctx.systemPrompt.register({ name: "test:consumer", order: 20, text: ctx.demo.value });
plugin.inject = ["demo", "systemPrompt"];
export default plugin;
`);
			await writeFile(join(workspace.dir, "provider.mjs"), `
const plugin = (ctx) => { ctx.provide("demo", { value: "dependency-driven activation" }); };
export default plugin;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: consumer
      name: ../consumer.mjs
    - id: provider
      name: ../provider.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.ctx.systemPrompt.render()).toContain("dependency-driven activation");
				expect(app.host.list().find((entry) => entry.entry.id === "consumer")?.state).toBe("active");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("classifies a deferred optional activation failure after its provider appears", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "late-fail.mjs"), `
const plugin = () => { throw new Error("late optional exploded"); };
plugin.inject = ["late-provider"];
export default plugin;
`);
			await writeFile(join(workspace.dir, "late-provider.mjs"), `
export default (ctx) => { ctx.provide("late-provider", { ready: true }); };
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: late-fail
      name: ../late-fail.mjs
    - id: late-provider
      name: ../late-provider.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.host.list().find((entry) => entry.entry.id === "late-fail")?.state).toBe("failed");
				expect(app.host.startupWarnings.join("\n")).toContain("late optional exploded");
				expect(app.ctx.get("systemPrompt")).toBeDefined();
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps an optional pending row as a warning, matching DSH app-boot", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "optional-pending.mjs"), `
const plugin = () => undefined;
plugin.inject = ["service-that-never-arrives"];
export default plugin;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: optional-pending
      name: ../optional-pending.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.host.list().find((entry) => entry.entry.id === "optional-pending")?.state).toBe("pending");
				expect(app.host.startupWarnings.join("\n")).toContain("service-that-never-arrives");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps an ordinary failed row as a warning while active siblings stay live", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(
				join(workspace.dir, "optional-fail.mjs"),
				"export default () => { throw new Error('ordinary optional failure') }\n",
			);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: optional-fail
      name: ../optional-fail.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.host.list().find((entry) => entry.entry.id === "optional-fail")?.state).toBe("failed");
				expect(app.host.startupWarnings.join("\n")).toContain("ordinary optional failure");
				expect(app.ctx.get("systemPrompt")).toBeDefined();
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps a nested group sibling active when another optional child cannot import", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "nested-good.mjs"), `
const plugin = (ctx) => ctx.systemPrompt.register({ name: "test:nested", order: 35, text: "nested sibling stayed active" });
plugin.inject = ["systemPrompt"];
export default plugin;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: fixture-group
      name: cordis:group
      group: true
      config:
        - id: nested-missing
          name: fixture-package-that-does-not-exist
        - id: nested-good
          name: ../nested-good.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.ctx.systemPrompt.render()).toContain("nested sibling stayed active");
				expect(app.host.startupWarnings.join("\n")).toContain("nested-missing");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("contains a circular optional import cause and keeps the tree live", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "cyclic-import.mjs"), `
const error = new Error("cyclic optional import");
error.cause = error;
throw error;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: cyclic-import
      name: ../cyclic-import.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.host.startupWarnings.join("\n")).toContain("cyclic optional import");
				expect(app.ctx.get("systemPrompt")).toBeDefined();
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps siblings live across optional config-schema and expression failures", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "schema-fail.mjs"), `
export const Config = {
  "~standard": {
    version: 1,
    vendor: "piharness-test",
    validate() { return { issues: [{ message: "schema fixture failure" }] }; },
  },
};
export function apply() {}
`);
			await writeFile(join(workspace.dir, "noop.mjs"), "export function apply() {}\n");
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: schema-fail
      name: ../schema-fail.mjs
    - id: config-expression-fail
      name: ../noop.mjs
      config:
        value: !!js "JSON.parse('invalid')"
    - id: disabled-expression-fail
      name: ../noop.mjs
      disabled: !!js "JSON.parse('invalid')"
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				const warning = app.host.startupWarnings.join("\n");
				expect(warning).toContain("schema fixture failure");
				expect(warning).toContain("config-expression-fail");
				expect(warning).toContain("disabled-expression-fail");
				expect(app.ctx.get("systemPrompt")).toBeDefined();
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("fails loud when a DSH startup-critical row remains pending", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "required-pending.mjs"), `
const plugin = () => undefined;
plugin.inject = ["required-service-that-never-arrives"];
export default plugin;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: headless-runner
      name: ../required-pending.mjs
`);
			await expect(createApp(await loadProfile(profileDir, { homePatch: false })))
				.rejects.toThrow("required startup failure");
		} finally {
			await workspace.cleanup();
		}
	});

	it("resolves a bare plugin from the profile-owned node_modules", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			const packageDir = join(profileDir, "node_modules", "fixture-focus");
			await mkdir(packageDir, { recursive: true });
			await writeFile(join(packageDir, "package.json"), JSON.stringify({
				name: "fixture-focus",
				version: "1.0.0",
				type: "module",
				exports: "./index.mjs",
			}));
			await writeFile(join(packageDir, "index.mjs"), `
const plugin = (ctx) => ctx.systemPrompt.register({ name: "test:bare", order: 30, text: "profile bare plugin" });
plugin.inject = ["systemPrompt"];
export default plugin;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: fixture-focus
      name: fixture-focus
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				expect(app.ctx.systemPrompt.render()).toContain("profile bare plugin");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("uses DSH whole-field patch semantics rather than merging row config", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- id: settings
  config:
    name: partial-only
`);
			await expect(loadProfile(profileDir, { homePatch: false })).rejects.toThrow("effective settings row is invalid");
		} finally {
			await workspace.cleanup();
		}
	});

	it("loads a bundle whose package exports hide package.json", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			const bundleDir = join(profileDir, "node_modules", "@fixture", "bundle");
			await mkdir(bundleDir, { recursive: true });
			await writeFile(join(bundleDir, "package.json"), JSON.stringify({
				name: "@fixture/bundle",
				version: "1.0.0",
				type: "module",
				exports: { ".": "./index.mjs" },
				dsh: { bundle: { patch: "./cordis.patch.yml" } },
			}));
			await writeFile(join(bundleDir, "index.mjs"), "export default () => undefined\n");
			await writeFile(join(bundleDir, "cordis.patch.yml"), `
- insert:
    - id: fixture-bundle-row
      name: cordis:piharness-workspace-info
      disabled: true
`);
			await writeFile(join(profileDir, "package.json"), JSON.stringify({
				name: "fixture-profile",
				private: true,
				dsh: { profile: { bundles: ["@my-agent/base", "@fixture/bundle"], patchReload: "startup" } },
			}));
			const profile = await loadProfile(profileDir, { homePatch: false });
			expect(profile.entries.some((entry) => entry.id === "fixture-bundle-row")).toBe(true);
		} finally {
			await workspace.cleanup();
		}
	});

	it("honors an overlay that disables a configured row", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			const overlay = join(workspace.dir, "disable.patch.yml");
			await writeFile(overlay, "- id: workspace-info\n  disabled: true\n");
			const app = await createApp(await loadProfile(profileDir, { homePatch: false, overlays: [overlay] }));
			try {
				const entry = app.host.list().find((candidate) => candidate.entry.id === "workspace-info");
				expect(entry?.state).toBe("disabled");
				const toolNames = app.ctx.tools.list().map((tool) => tool.name);
				expect(toolNames).not.toContain("workspace_info");
				expect(toolNames).toEqual(expect.arrayContaining(["read", "write", "edit", "bash"]));
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("replaces the Pi loop through the AgentFactory seam without changing consumers", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "fake-loop.mjs"), `
function handle(id) {
  let disposed = false;
  const agent = {
    id,
    get status() { return disposed ? "disposed" : "idle"; },
    async send(prompt) { return { sessionId: id, model: { provider: "fixture", id: "fixture" }, text: "fake:" + prompt, messageCount: 2 }; },
    cancel() { return false; },
    async whenIdle() {},
  };
  return { agent, async dispose() { disposed = true; } };
}
const plugin = (ctx) => ctx.agents.setFactory({
  async createAgent(_owner, options) { return handle(options.sessionId); },
  async resume(_owner, options) { return handle(options.resumeSessionId); },
});
plugin.inject = ["agents"];
export default plugin;
`);
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- id: agent-loop
  disabled: true
- insert:
    - id: fixture-agent-loop
      name: ../fake-loop.mjs
`);
			const app = await createApp(await loadProfile(profileDir, { homePatch: false }));
			try {
				const result = await app.ctx.agents.run("hello");
				expect(result.text).toBe("fake:hello");
				expect(app.host.list().find((entry) => entry.entry.id === "agent-loop")?.state).toBe("disabled");
				expect(app.host.list().find((entry) => entry.entry.id === "fixture-agent-loop")?.state).toBe("active");
			} finally {
				await app.stop();
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("fails loud and unwinds active siblings when a startup-critical row throws", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "failing.mjs"), "export default () => { throw new Error('intentional startup failure') }\n");
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: headless-runner
      name: ../failing.mjs
`);
			const ctx = new Context();
			const host = new PluginHost(await loadProfile(profileDir, { homePatch: false }), ctx);
			await expect(host.start()).rejects.toThrow("intentional startup failure");
			expect(ctx.get("systemPrompt")).toBeUndefined();
		} finally {
			await workspace.cleanup();
		}
	});

	it("reports optional failures before rejecting a startup-critical failure", async () => {
		const workspace = await tempWorkspace();
		try {
			const profileDir = await freshProfile(workspace.dir);
			await writeFile(join(workspace.dir, "optional-first.mjs"), "export default () => { throw new Error('optional first') }\n");
			await writeFile(join(workspace.dir, "required-second.mjs"), "export default () => { throw new Error('required second') }\n");
			await writeFile(join(profileDir, "cordis.patch.yml"), `
- insert:
    - id: optional-first
      name: ../optional-first.mjs
    - id: headless-runner
      name: ../required-second.mjs
`);
			const host = new PluginHost(await loadProfile(profileDir, { homePatch: false }), new Context());
			await expect(host.start()).rejects.toThrow("required second");
			expect(host.startupWarnings.join("\n")).toContain("optional first");
		} finally {
			await workspace.cleanup();
		}
	});
});
