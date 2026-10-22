import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { initProfile, loadProfile } from "../src/profile.js";
import { tempWorkspace } from "./helpers.js";

describe("BuildMe full edition", () => {
	it("keeps the standard tool set small and enables DSH-style capability families only in full mode", async () => {
		const fixture = await tempWorkspace();
		const profile = join(fixture.dir, "profile");
		await mkdir(profile);
		await initProfile(profile, "BuildMe");
		const app = await createApp(await loadProfile(profile));
		try {
			const standard = app.ctx.tools.list({ workspacePath: fixture.dir, permissionMode: "bypass", edition: "standard" }).map((tool) => tool.name);
			const full = app.ctx.tools.list({ workspacePath: fixture.dir, permissionMode: "bypass", edition: "full" });
			expect(standard).not.toContain("files_search");
			expect(standard).not.toContain("platform_propose");
			expect(full.map((tool) => tool.name)).toEqual(expect.arrayContaining([
				"files_search", "web_fetch", "todo_manage", "plan_manage", "skill_catalog", "delegate_task", "workflow_run", "platform_catalog", "platform_propose", "platform_execute",
			]));
			for (const retired of ["research_project", "research_update"]) expect(full.map((tool) => tool.name)).not.toContain(retired);

			const todos = full.find((tool) => tool.name === "todo_manage");
			if (!todos) throw new Error("Missing todo_manage");
			await todos.execute("todo-1", { action: "replace", items: [{ text: "Ship BuildMe full mode" }] });
			expect(JSON.parse(await readFile(join(fixture.dir, ".buildme", "todos.json"), "utf8"))).toEqual([
				{ text: "Ship BuildMe full mode", done: false },
			]);
		} finally {
			await app.stop();
			await fixture.cleanup();
		}
	});

	it("loads the user's own skill and saves a platform proposal without applying it", async () => {
		const fixture = await tempWorkspace(); const profile = join(fixture.dir, "profile");
		await mkdir(profile); await initProfile(profile, "BuildMe");
		const skillDir = join(fixture.dir, ".buildme", "skills", "custom-spectra-review");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: custom-spectra-review\ndescription: Review the user's own instrument exports.\n---\nUse the platform's configured columns and preserve the original source.\n");
		await writeFile(join(skillDir, "checklist.txt"), "Confirm device ID and source file.\n");
		const app = await createApp(await loadProfile(profile));
		try {
			const tools = app.ctx.tools.list({ workspacePath: fixture.dir, permissionMode: "bypass", edition: "full", capabilities: ["core", "skills"] });
			const catalog = tools.find((tool) => tool.name === "skill_catalog"); const load = tools.find((tool) => tool.name === "skill_load");
			const platformCatalog = tools.find((tool) => tool.name === "platform_catalog"), propose = tools.find((tool) => tool.name === "platform_propose");
			if (!catalog || !load || !platformCatalog || !propose) throw new Error("Custom platform and skill tools were not exposed to the Pi execution scope.");
			const listed = await catalog.execute("skill-catalog", {});
			const entries = (listed.details as { skills: { name: string; scope: string }[] }).skills;
			expect(entries.find((item) => item.name === "custom-spectra-review")).toMatchObject({ scope: "workspace" });
			expect(entries.some((entry) => entry.scope === "builtin")).toBe(false);
			const delivered = await load.execute("custom-load", { name: "custom-spectra-review" });
			expect(delivered.details).toMatchObject({ name: "custom-spectra-review", scope: "workspace", file: join(skillDir, "SKILL.md"), supporting: expect.arrayContaining(["checklist.txt"]) });
			expect(delivered.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).toContain(await readFile(join(skillDir, "SKILL.md"), "utf8"));

			const before = await platformCatalog.execute("platform-list-before", {});
			expect(JSON.parse(before.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"))).toMatchObject({ platforms: [], proposals: [], moduleCatalog: expect.any(Array) });
			const definition = { name: "我的光谱记录平台", description: "由用户选择页面、字段和能力", pages: [{ id: "spectra", title: "光谱记录", kind: "records", fields: [{ id: "device_id", label: "设备编号", type: "text" }, { id: "peak", label: "峰位置", type: "number", unit: "cm-1" }] }], capabilities: ["records", "files"], assistant: { role: "光谱资料整理助手", instructions: "按照用户自定义字段记录资料" }, workflows: [] };
			const result = await propose.execute("platform-proposal", { definition, reason: "使用自己的设备编号和峰位置字段" });
			const proposal = JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")) as { id: string; status: string; definition: { name: string } };
			expect(proposal).toMatchObject({ status: "draft", definition: { name: definition.name } });
			const saved = JSON.parse(await readFile(join(fixture.dir, ".buildme", "platforms", "proposals", `${proposal.id}.json`), "utf8"));
			expect(saved).toMatchObject({ status: "draft", reason: "使用自己的设备编号和峰位置字段" });
			expect(await readdir(join(fixture.dir, ".buildme", "platforms"))).toEqual(["proposals"]);
			const after = await platformCatalog.execute("platform-list-after", {});
			expect(JSON.parse(after.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"))).toMatchObject({ platforms: [], proposals: [{ id: proposal.id, status: "draft" }] });
		} finally { await app.stop(); await fixture.cleanup(); }
	});
});
