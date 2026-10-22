import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { RESEARCH_MODULES, RESEARCH_MODULE_IDS, composeModuleDefinition, validateResearchModule } from "../desktop/platform-modules.mjs";
import { PlatformStore, validateDefinition } from "../desktop/platform-store.mjs";
import { PlatformService } from "../desktop/platform-service.mjs";

const blank = () => ({ name: "我的科研平台", pages: [], capabilities: [], workflows: [] });
const userModule = (extra = {}) => ({ title: "吸附检测", description: "整理自己的测量结果", pages: [
  { id: "data", title: "吸附数据", kind: "records", fields: [{ id: "sample", label: "样品编号", type: "text", required: true }, { id: "group", label: "处理组", type: "text" }, { id: "reading", label: "读数", type: "number", unit: "mg/g" }] },
  { id: "analysis", title: "吸附分析", kind: "analysis", sourcePageId: "data", valueField: "reading", groupField: "group", sampleField: "sample" },
], capabilities: ["files"], ...extra });

async function sandbox(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buildme-module-test-"));
  const actual = path.resolve(root);
  if (path.dirname(actual) !== path.resolve(os.tmpdir()) || !path.basename(actual).startsWith("buildme-module-test-")) throw new Error("无效测试清理目录");
  const workspace = path.join(root, "workspace"), userData = path.join(root, "userdata");
  await fs.mkdir(workspace);
  const options = { userData, getWorkspace: async () => workspace };
  try { return await operation({ root, workspace, options, store: new PlatformStore(workspace), service: new PlatformService(options) }); }
  finally { await fs.rm(actual, { recursive: true, force: true }); }
}

describe("composable research modules", () => {
  it("canonicalizes reusable modules with stable isolated IDs, analysis references and implied capabilities", () => {
    const first = validateResearchModule(userModule()), second = validateResearchModule(userModule());
    expect(first.id).toMatch(/^custom_[0-9a-f]{32}$/);
    expect(first.pages[0].id).not.toBe(second.pages[0].id);
    expect(first.pages.every(page => page.moduleId === first.id)).toBe(true);
    expect(first.pages[1].sourcePageId).toBe(first.pages[0].id);
    expect(first.pages[1].valueField).toBe("reading");
    expect(first.capabilities).toEqual(["files", "records", "statistics", "charts"]);
    expect(validateResearchModule(first)).toEqual(first);
    const long = validateResearchModule(userModule({ id: `custom_${"a".repeat(55)}`, pages: [{ id: "b".repeat(64), title: "长编号", kind: "notes" }] }));
    expect(long.pages[0].id.length).toBeLessThanOrEqual(64);
    expect(validateResearchModule(long)).toEqual(long);
  });

  it("rejects empty modules, builtin replacement, unsafe IDs, unknown capabilities and external analysis references", () => {
    for (const input of [userModule({ title: " " }), userModule({ id: "samples" }), userModule({ id: "custom_../escape" }), userModule({ pages: [] }), userModule({ pages: [{ id: "data", title: "空页面", kind: "records", fields: [] }] }), userModule({ capabilities: ["execute"] }), userModule({ color: "url(file:///x)" })]) expect(() => validateResearchModule(input)).toThrow();
    const external = userModule(); external.pages[1].sourcePageId = "module_analysis_data";
    expect(() => validateResearchModule(external)).toThrow("引用");
    const missing = userModule(); missing.pages[1].valueField = "unknown";
    expect(() => validateResearchModule(missing)).toThrow("不存在");
    const wrongType = userModule(); wrongType.pages[1].valueField = "sample";
    expect(() => validateResearchModule(wrongType)).toThrow("数字类型");
    const hostile = JSON.parse(JSON.stringify(userModule()).replace('"title":"吸附检测"', '"title":"吸附检测","__proto__":{"polluted":true}'));
    expect(() => validateResearchModule(hostile)).toThrow("不安全");
    const executable = userModule({ pages: [{ id: "code", title: "执行代码", kind: "javascript", script: "print(1)" }] });
    expect(() => validateResearchModule(executable)).toThrow("页面类型");
  });

  it("persists the workspace catalog across service reloads without enabling or creating a platform", async () => sandbox(async ({ service, options, workspace, root }) => {
    await service.select(null);
    const state = await service.saveModule(userModule());
    expect(state.platforms).toEqual([]); expect(state.activePlatformId).toBeNull(); expect(state.snapshot).toBeNull();
    expect(state.moduleCatalog).toHaveLength(12);
    const id = state.savedModule.id;
    const reopened = await new PlatformService(options).state();
    expect(reopened.moduleCatalog.find(module => module.id === id)).toEqual(state.savedModule);
    const updated = await service.saveModule({ ...state.savedModule, title: "自己的吸附模块" });
    expect(updated.moduleCatalog).toHaveLength(12);
    expect(updated.savedModule.id).toBe(id);
    const otherWorkspace = path.join(root, "other"); await fs.mkdir(otherWorkspace);
    expect((await new PlatformStore(otherWorkspace).listModules())).toEqual([]);
    expect((await new PlatformStore(workspace).list()).length).toBe(0);
    const configured = await service.create(composeModuleDefinition(blank(), [id], updated.moduleCatalog));
    const savedAgain = await service.saveModule(userModule({ title: "另一个模块" }));
    expect(savedAgain.activePlatformId).toBe(configured.activePlatformId);
    expect(savedAgain.snapshot.definitionVersion).toBe(1);
    expect(savedAgain.snapshot.definition.modules).toEqual([id]);
  }));

  it("composes more than eleven modules, preserves custom edits after toggling and validates portable ownership", () => {
    const first = validateResearchModule(userModule()), second = validateResearchModule(userModule({ title: "第二个数据模块" }));
    const selected = [...RESEARCH_MODULE_IDS, first.id, second.id];
    const original = composeModuleDefinition(blank(), selected, [...RESEARCH_MODULES, first, second]);
    expect(validateDefinition(original).modules).toHaveLength(13);
    expect(new Set(original.pages.map(page => page.id)).size).toBe(original.pages.length);
    expect(original.customModules).toHaveLength(2);
    original.pages.find(page => page.moduleId === first.id && page.kind === "records").fields.push({ id: "detail", label: "额外信息", type: "text" });
    const disabled = composeModuleDefinition(original, ["samples"]);
    const restored = composeModuleDefinition(disabled, [first.id, "samples"]);
    expect(restored.pages.find(page => page.moduleId === first.id && page.kind === "records").fields.at(-1).id).toBe("detail");
    expect(() => validateDefinition(restored)).not.toThrow();
    expect(() => validateDefinition({ ...restored, customModules: [] })).toThrow("未知");
    expect(() => validateDefinition({ ...blank(), modules: ["custom_missing"] })).toThrow("未知");
    expect(() => validateDefinition({ ...blank(), customModules: [{ ...first, id: "samples" }] })).toThrow("内置");
  });

  it("exports portable module definitions and imports a functioning module into a fresh workspace", async () => sandbox(async ({ service, root }) => {
    const saved = await service.saveModule(userModule());
    const created = await service.create(composeModuleDefinition(blank(), [saved.savedModule.id, "samples"], saved.moduleCatalog));
    const templatePath = path.join(root, "portable.json"); await service.templateExport(templatePath);
    const otherWorkspace = path.join(root, "imported"), otherUserData = path.join(root, "imported-userdata"); await fs.mkdir(otherWorkspace);
    const importedService = new PlatformService({ userData: otherUserData, getWorkspace: async () => otherWorkspace });
    const imported = await importedService.templateImport(templatePath);
    expect(imported.moduleCatalog.find(module => module.id === saved.savedModule.id)).toEqual(saved.savedModule);
    expect(imported.snapshot.definition.customModules).toEqual(created.snapshot.definition.customModules);
    const dataPage = imported.snapshot.definition.pages.find(page => page.moduleId === saved.savedModule.id && page.kind === "records");
    await importedService.record({ pageId: dataPage.id, values: { sample: "S1", group: "A", reading: 12 } });
    const analyzed = await importedService.analyze({ pageId: dataPage.id, valueField: "reading", groupField: "group", sampleField: "sample" });
    expect(analyzed.snapshot.runs[0].result.rows[0].mean).toBe(12);
    expect((await new PlatformStore(otherWorkspace).listModules())).toEqual([]);
  }));

  it("normalizes custom page ownership and workflow source IDs on raw portable definitions", () => {
    const module = validateResearchModule(userModule({ id: "custom_measurements" }));
    const raw = { ...blank(), modules: [module.id], customModules: [module], pages: userModule().pages.map(page => ({ ...page, moduleId: module.id })), workflows: [{ id: "run", title: "分析", steps: ["analyze"], sourcePageId: "data", valueField: "reading" }] };
    const definition = validateDefinition(raw);
    expect(definition.pages[0].id).toBe(module.pages[0].id);
    expect(definition.pages[1].sourcePageId).toBe(module.pages[0].id);
    expect(definition.workflows[0].sourcePageId).toBe(module.pages[0].id);
    expect(validateDefinition(definition)).toEqual(definition);
  });

  it("refuses module storage junctions and linked module files outside the workspace", async () => sandbox(async ({ root, workspace, store }) => {
    const outside = path.join(root, "outside"); await fs.mkdir(outside);
    const module = await store.saveModule(userModule());
    const directory = path.join(workspace, ".buildme", "platforms", ".modules"), filename = path.join(directory, `${module.id}.json`);
    const external = path.join(outside, "module.json"); await fs.copyFile(filename, external); await fs.unlink(filename);
    try { await fs.symlink(external, filename, "file"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
    await expect(store.listModules()).rejects.toThrow("链接文件");
    await expect(store.saveModule(module)).rejects.toThrow("链接文件");
  }));

  it("refuses custom catalog storage through an outside directory junction", async () => sandbox(async ({ root, workspace, store }) => {
    const outside = path.join(root, "outside"), directory = path.join(workspace, ".buildme", "platforms");
    await fs.mkdir(outside); await fs.mkdir(directory, { recursive: true });
    await fs.symlink(outside, path.join(directory, ".modules"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.saveModule(userModule())).rejects.toThrow("边界");
    await expect(store.listModules()).rejects.toThrow("边界");
    expect(await fs.readdir(outside)).toEqual([]);
  }));

  it("exposes the requested eleven independent modules using the supported page schema", () => {
    expect(RESEARCH_MODULE_IDS).toEqual(["datasets", "code", "comparison", "reports", "samples", "protocols", "experiments", "analysis", "search", "screening", "writing"]);
    expect(RESEARCH_MODULES.map((module) => module.title)).toEqual(["数据集管理", "代码运行", "实验比较", "图表与报告", "样本管理", "实验方案", "实验记录", "数据分析", "检索记录", "文献筛选", "综合写作"]);
    for (const module of RESEARCH_MODULES) {
      const configured = validateDefinition(composeModuleDefinition(blank(), [module.id]));
      expect(configured.modules).toEqual([module.id]);
      expect(configured.pages.length).toBeGreaterThan(0);
      expect(configured.pages.every((page) => page.moduleId === module.id)).toBe(true);
    }
    const together = validateDefinition(composeModuleDefinition(blank(), RESEARCH_MODULE_IDS));
    expect(new Set(together.pages.map((page) => page.id)).size).toBe(together.pages.length);
  });

  it("retains selection order and edits to custom and retained module pages without mutating the input", () => {
    const original = composeModuleDefinition(blank(), ["samples", "analysis"]);
    original.pages.unshift({ id: "custom", title: "个人笔记", kind: "notes" });
    original.pages.find((page) => page.moduleId === "samples").fields.push({ id: "custom_condition", label: "自定义条件", type: "text" });
    const next = composeModuleDefinition(original, ["analysis", "samples", "writing"]);
    expect(next.modules).toEqual(["analysis", "samples", "writing"]);
    expect(next.pages.map((page) => page.id)).toEqual(["custom", "module_analysis_data", "module_analysis_results", "module_samples", "module_writing"]);
    expect(next.pages.find((page) => page.moduleId === "samples").fields.at(-1).id).toBe("custom_condition");
    expect(original.modules).toEqual(["samples", "analysis"]);
    expect(original.pages).toHaveLength(4);
    expect(() => validateDefinition(next)).not.toThrow();
    expect(() => composeModuleDefinition({ ...blank(), pages: [{ id: "module_samples", title: "自定义", kind: "notes" }] }, ["samples"])).toThrow("编号冲突");
  });

  it("validates safe module identifiers and matching page ownership while keeping legacy and empty configurations valid", () => {
    expect(Object.hasOwn(validateDefinition(blank()), "modules")).toBe(false);
    expect(validateDefinition({ ...blank(), modules: [] }).modules).toEqual([]);
    expect(() => validateDefinition({ ...blank(), modules: [], pages: [{ id: "custom", title: "自定义记录", kind: "records", fields: [] }] })).not.toThrow();
    for (const modules of [["constructor"], ["../samples"], ["unknown"], ["samples", "samples"]]) expect(() => validateDefinition({ ...blank(), modules })).toThrow();
    expect(() => validateDefinition({ ...blank(), modules: "samples" })).toThrow("数组");
    const configured = composeModuleDefinition(blank(), ["samples"]);
    expect(() => validateDefinition({ ...configured, modules: [] })).toThrow("尚未选择");
    const invalidOwner = globalThis.structuredClone(configured); invalidOwner.pages[0].moduleId = "unknown";
    expect(() => validateDefinition(invalidOwner)).toThrow("不存在");
    const legacyWithOwner = globalThis.structuredClone(configured); delete legacyWithOwner.modules;
    expect(validateDefinition(legacyWithOwner).pages[0].moduleId).toBe("samples");
    expect(() => composeModuleDefinition(blank(), ["samples", "samples"])).toThrow("不能重复");
  });

  it("persists module configuration, archives removed pages with their records, and restores their field definitions", async () => sandbox(async ({ store, workspace }) => {
    const configured = composeModuleDefinition(blank(), ["writing", "samples"]);
    configured.pages.find((page) => page.moduleId === "samples").fields.push({ id: "custom", label: "额外信息", type: "text" });
    const created = await store.create(configured), id = created.definition.id;
    await store.record(id, "module_samples", { values: { sample_id: "S1", custom: "保留" } });
    const revised = await store.revise(id, composeModuleDefinition(created.definition, ["writing"]), { expectedVersion: 1 });
    expect(revised.definition.modules).toEqual(["writing"]);
    expect(revised.archivedPages.find((page) => page.id === "module_samples").moduleId).toBe("samples");
    expect(revised.records[0].values).toEqual({ sample_id: "S1", custom: "保留" });
    const reopened = await new PlatformStore(workspace).get(id);
    expect(reopened.definition.modules).toEqual(["writing"]);
    const restored = await store.restore(id, 1);
    expect(restored.definition.modules).toEqual(["writing", "samples"]);
    expect(restored.definition.pages.find((page) => page.id === "module_samples").fields.at(-1).id).toBe("custom");
    expect(restored.records[0].values.custom).toBe("保留");
  }));

  it.each(["analysis", "comparison"])("allows %s alone to import values and compute statistics", async (moduleId) => sandbox(async ({ root, service }) => {
    const configured = composeModuleDefinition(blank(), [moduleId]);
    await service.create(configured);
    const dataPage = configured.pages.find((page) => page.kind === "records"), resultsPage = configured.pages.find((page) => page.kind === "analysis");
    const filename = path.join(root, "values.csv");
    await fs.writeFile(filename, `${dataPage.fields.map((field) => field.label).join(",")}\na,A,10,first\na,A,14,repeat\nb,A,20,next\n`);
    const imported = await service.importFile(filename, { pageId: dataPage.id });
    expect(imported.snapshot.records).toHaveLength(3);
    const analyzed = await service.analyze({ pageId: resultsPage.sourcePageId, valueField: resultsPage.valueField, groupField: resultsPage.groupField, sampleField: resultsPage.sampleField });
    expect(analyzed.snapshot.runs[0].result.rows[0]).toMatchObject({ n: 2, readings: 3, mean: 16 });
    expect(analyzed.snapshot.runs[0].assetIds).toEqual([imported.snapshot.assets[0].id]);
  }));

  it("returns catalog without creating workspace data and routes code requests to the existing Agent prompt", async () => sandbox(async ({ workspace, service, root }) => {
    const initial = await service.state();
    expect(initial.moduleCatalog).toEqual(RESEARCH_MODULES);
    await expect(fs.stat(path.join(workspace, ".buildme"))).rejects.toMatchObject({ code: "ENOENT" });
    const configured = composeModuleDefinition(blank(), ["code", "writing"]);
    await service.create(configured);
    await service.record({ pageId: "module_code", values: { run_id: "analysis.py", script: "print(1)", status: "尚未运行" } });
    const { prompt } = await service.prompt({ task: "code", requirement: "执行已保存的脚本" });
    expect(prompt).toContain("现有工具");
    expect(prompt).toContain("仅在实际执行后");
    expect((await service.state()).snapshot.runs).toEqual([]);
    const target = path.join(root, "module-template.json");
    await service.templateExport(target);
    const exported = JSON.parse(await fs.readFile(target, "utf8"));
    expect(exported.definition.modules).toEqual(["code", "writing"]);
    expect(exported.definition.pages[0].moduleId).toBe("code");
    const imported = await service.templateImport(target);
    expect(imported.snapshot.definition.modules).toEqual(["code", "writing"]);
    expect(imported.snapshot.records).toEqual([]);
  }));
});
