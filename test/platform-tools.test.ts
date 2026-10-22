import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPlatformProposal, listPlatformProposals, markPlatformProposalApplied, platformCatalogTool, platformProposeTool } from "../src/core/platform-tools.js";

const fixtures: string[] = [];
const storeUrl = new URL("../desktop/platform-store.mjs", import.meta.url).href;
const baseDefinition = () => ({ name: "自定义光谱平台", description: "自己的字段和流程", pages: [{ id: "spectra", title: "光谱记录", kind: "records", fields: [{ id: "device", label: "设备编号", type: "text" }, { id: "peak", label: "峰位置", type: "number" }] }], capabilities: ["records", "files"], assistant: { role: "资料整理助手", instructions: "保留来源" }, workflows: [] });
async function fixture() { const workspace = await mkdtemp(join(tmpdir(), "platform-tool-")); fixtures.push(workspace); return workspace; }
async function store(workspace: string) { const module = await import(storeUrl); return new module.PlatformStore(workspace); }
afterEach(async () => {
	for (const workspace of fixtures.splice(0)) {
		const target = resolve(workspace); expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^platform-tool-/);
		await rm(target, { recursive: true, force: true });
	}
});

describe("Agent platform proposals are reviewable data, not platform mutations", () => {
	it("reads an empty catalog without creating files", async () => {
		const workspace = await fixture();
		const catalog = await platformCatalogTool(workspace, {}) as { platforms: unknown[]; proposals: unknown[]; moduleCatalog: { id: string }[] };
		expect(catalog).toMatchObject({ platforms: [], proposals: [] });
		expect(catalog.moduleCatalog).toHaveLength(11);
		expect(catalog.moduleCatalog.map(module => module.id)).toContain("analysis");
		expect(await readdir(workspace)).toEqual([]);
	});
	it("exposes saved and portable custom modules in the Agent catalog and keeps proposal definitions portable", async () => {
		const workspace = await fixture(), s = await store(workspace);
		const module = await s.saveModule({ title: "自己的笔记", pages: [{ id: "notes", title: "观察", kind: "notes" }], capabilities: ["notes"] });
		const catalog = await platformCatalogTool(workspace, {}) as { moduleCatalog: { id: string }[] };
		expect(catalog.moduleCatalog.map(entry => entry.id)).toContain(module.id);
		const portableDefinition = { ...baseDefinition(), modules: [module.id], customModules: [module], pages: module.pages };
		const proposal = await platformProposeTool(workspace, { definition: portableDefinition });
		expect(proposal.definition.customModules).toEqual([module]);
		const otherWorkspace = await fixture(), otherStore = await store(otherWorkspace);
		await otherStore.create(proposal.definition);
		expect(await otherStore.listModules()).toEqual([]);
		const portableCatalog = await platformCatalogTool(otherWorkspace, {}) as { moduleCatalog: { id: string }[] };
		expect(portableCatalog.moduleCatalog.map(entry => entry.id)).toContain(module.id);
	});
	it("saves a validated full draft without creating a platform, then records explicit application", async () => {
		const workspace = await fixture(); const proposal = await platformProposeTool(workspace, { definition: baseDefinition(), reason: "根据你的光谱研究整理自定义字段" });
		expect(proposal.status).toBe("draft"); expect(proposal.message).toContain("尚未改变");
		const s = await store(workspace); expect(await s.list()).toEqual([]);
		expect(JSON.parse(await readFile(join(workspace, ".buildme/platforms/proposals", `${proposal.id}.json`), "utf8"))).toMatchObject({ id: proposal.id, reason: proposal.reason });
		expect(await listPlatformProposals(workspace)).toEqual([expect.objectContaining({ id: proposal.id, definition: expect.objectContaining({ name: "自定义光谱平台" }) })]);
		const created = await s.create(proposal.definition);
		const applied = await markPlatformProposalApplied(workspace, proposal.id, created.definition.id);
		expect(applied).toMatchObject({ status: "applied", appliedPlatformId: created.definition.id });
		expect(await listPlatformProposals(workspace)).toEqual([]); expect((await getPlatformProposal(workspace, proposal.id)).status).toBe("applied");
		await expect(markPlatformProposalApplied(workspace, proposal.id, created.definition.id)).rejects.toThrow("重复");
	});
	it("requires an observed version for revisions and keeps platform records untouched", async () => {
		const workspace = await fixture(); const s = await store(workspace); const original = await s.create(baseDefinition());
		const id = original.definition.id;
		const definition = { ...baseDefinition(), name: "新增统计设计" };
		await expect(platformProposeTool(workspace, { platformId: id, definition })).rejects.toThrow("expectedVersion");
		await expect(platformProposeTool(workspace, { platformId: id, expectedVersion: 999, definition })).rejects.toThrow("已改变");
		const proposal = await platformProposeTool(workspace, { platformId: id, expectedVersion: 1, definition });
		expect(proposal).toMatchObject({ platformId: id, expectedVersion: 1, status: "draft" });
		expect(await s.get(id)).toEqual(original);
		expect(await platformCatalogTool(workspace, { platformId: id })).toEqual(original);
		const other = await s.create(baseDefinition()); await expect(markPlatformProposalApplied(workspace, proposal.id, other.definition.id)).rejects.toThrow("其他平台");
	});
	it("rejects path IDs, prototype keys, executable page types and invalid analysis references before writing", async () => {
		const workspace = await fixture();
		await expect(platformCatalogTool(workspace, { platformId: "../escape" })).rejects.toThrow("UUID");
		await expect(getPlatformProposal(workspace, "../../outside")).rejects.toThrow("UUID");
		const unsafe = JSON.parse(JSON.stringify(baseDefinition()).replace('"description":"自己的字段和流程"', '"description":"自己的字段和流程","__proto__":{"polluted":true}'));
		await expect(platformProposeTool(workspace, { definition: unsafe })).rejects.toThrow("属性名称");
		const malformed = { ...baseDefinition(), pages: [{ id: "run", title: "任意脚本", kind: "javascript", command: "execute" }] };
		await expect(platformProposeTool(workspace, { definition: malformed })).rejects.toThrow("页面类型");
		const mismatched = { ...baseDefinition(), pages: [...baseDefinition().pages, { id: "analysis", title: "分析", kind: "analysis", sourcePageId: "spectra", valueField: "unknown" }] };
		await expect(platformProposeTool(workspace, { definition: mismatched })).rejects.toThrow("不存在");
		expect(await readdir(workspace)).toEqual([]);
	});
	it("refuses proposal storage through a directory junction outside the workspace", async () => {
		const workspace = await fixture(), outside = await fixture();
		await symlink(outside, join(workspace, ".buildme"), process.platform === "win32" ? "junction" : "dir");
		await expect(platformProposeTool(workspace, { definition: baseDefinition() })).rejects.toThrow("边界");
		expect(await readdir(outside)).toEqual([]);
	});
});
