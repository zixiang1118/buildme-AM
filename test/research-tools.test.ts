import { describe, expect, it } from "vitest";
import { ResearchStore } from "../src/core/research-store.js";
import { researchProjectTool, researchUpdateTool } from "../src/core/research-tools.js";
import { tempWorkspace } from "./helpers.js";

describe("research tools shared by Pi and DSH", () => {
	it("loads persisted projects and restricts assistant-origin measurements", async () => {
		const fixture = await tempWorkspace();
		try {
			const project = await new ResearchStore(fixture.dir).createProject({ title: "药化测试", objective: "已有分子系列", target: "示例体系" });
			const projectId = project.project.id;
			expect(await researchProjectTool(fixture.dir, {})).toEqual(expect.arrayContaining([expect.objectContaining({ id: projectId })]));
			await researchUpdateTool(fixture.dir, { projectId, action: "addCompound", data: { name: "示例结构", smiles: "CCO", provenance: "proposed" } });
			await expect(researchUpdateTool(fixture.dir, { projectId, action: "addClaim", data: { provenance: "measured" } })).rejects.toThrow("实测");
			await expect(researchUpdateTool(fixture.dir, { projectId, action: "recordRun", data: { status: "completed" } })).rejects.toThrow("实际化学反应");
			await expect(researchUpdateTool(fixture.dir, { projectId, action: "executeShell", data: {} })).rejects.toThrow("受支持");
		} finally { await fixture.cleanup(); }
	});
});
