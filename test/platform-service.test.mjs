import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PlatformService } from "../desktop/platform-service.mjs";
import { PlatformStore } from "../desktop/platform-store.mjs";
import { platformProposeTool, getPlatformProposal } from "../dist/core/platform-tools.js";

const definition = () => ({ schemaVersion: 1, name: "用户自己的检测平台", description: "测试可配置字段", capabilities: ["records", "files", "statistics", "charts", "notes"],
  pages: [{ id: "measurements", title: "我的检测记录", kind: "records", fields: [
    { id: "specimen", label: "样品编号", type: "text", required: true }, { id: "condition", label: "处理条件", type: "text" },
    { id: "response", label: "吸附响应", type: "number", unit: "mg/g" }, { id: "memo", label: "异常备注", type: "longtext" },
  ] }, { id: "comparison", title: "我的比较", kind: "analysis", sourcePageId: "measurements", valueField: "response", groupField: "condition", sampleField: "specimen" },
  { id: "journal", title: "观察笔记", kind: "notes" }], assistant: { role: "我的科研助手", instructions: "核查数据来源" },
  workflows: [{ id: "review", title: "我的数据流程", steps: ["import", "analyze", "report"], sourcePageId: "measurements", valueField: "response", groupField: "condition", sampleField: "specimen" }] });

async function sandbox(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buildme-platform-service-"));
  const actual = path.resolve(root);
  if (path.dirname(actual) !== path.resolve(os.tmpdir()) || !path.basename(actual).startsWith("buildme-platform-service-")) throw new Error("无效测试清理目录");
  const workspace = path.join(root, "workspace"), userData = path.join(root, "userdata"), exports = path.join(root, "exports");
  await Promise.all([fs.mkdir(workspace), fs.mkdir(userData), fs.mkdir(exports)]);
  const options = { userData, getWorkspace: async () => workspace, getModelConnections: async () => [{ id: "configured-model", name: "测试模型" }] };
  const service = new PlatformService(options);
  try { return await operation({ root, workspace, userData, exports, service, options }); }
  finally { await fs.rm(actual, { recursive: true, force: true }); }
}

const csv = "样品编号,处理条件,吸附响应,异常备注,额外列\r\na,A,10,首次,x\r\na,A,14,技术重复,x\r\nb,A,20,,x\r\nc,A,30,,x\r\nd,A,,,x\r\n";
const analysisOptions = { pageId: "measurements", valueField: "response", groupField: "condition", sampleField: "specimen" };

describe("configurable platform service", () => {
  it("persists an explicitly disabled selection across reloads and allows re-enabling a saved platform", async () => sandbox(async ({ service, options, workspace, userData }) => {
    const created = await service.create(definition()), key = created.activePlatformId;
    await service.record({ pageId: "measurements", values: { specimen: "saved", response: 4 } });
    const disabled = await service.select(null);
    expect(disabled.activePlatformId).toBeNull();
    expect(disabled.snapshot).toBeNull();
    expect(disabled.platforms).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(userData, "platform-selection.json"), "utf8"))[workspace]).toBeNull();
    const reloaded = new PlatformService(options);
    expect((await reloaded.state()).activePlatformId).toBeNull();
    expect((await reloaded.prompt({ task: "literature", requirement: "材料来源" })).prompt).not.toContain(`当前平台ID：${key}`);
    await expect(reloaded.current()).rejects.toThrow("请先搭建或选择");
    const enabled = await reloaded.select(key);
    expect(enabled.activePlatformId).toBe(key);
    expect(enabled.snapshot.records[0].values).toMatchObject({ specimen: "saved", response: 4 });
    expect((await new PlatformService(options).state()).activePlatformId).toBe(key);
    await expect(reloaded.select(undefined)).rejects.toThrow("编号无效");
  }));

  it("uses the first saved platform only for an absent selection and leaves a stale selection disabled", async () => sandbox(async ({ service, workspace, userData }) => {
    const snapshot = await new PlatformStore(workspace).create(definition());
    expect((await service.state()).activePlatformId).toBe(snapshot.definition.id);
    await fs.writeFile(path.join(userData, "platform-selection.json"), JSON.stringify({ [workspace]: "missing-platform" }));
    expect((await service.state()).activePlatformId).toBeNull();
    expect((await service.state()).snapshot).toBeNull();
  }));

  it("preserves selection when removing an inactive platform and persists disabled after removing the active platform", async () => sandbox(async ({ root, service, options }) => {
    const first = await service.create(definition()), inactive = first.activePlatformId;
    const second = await service.create({ ...definition(), name: "当前平台" }), active = second.activePlatformId;
    const third = await service.create({ ...definition(), name: "其他保留平台" }), retained = third.activePlatformId;
    await service.select(active);
    const source = path.join(root, "preserved.csv"); await fs.writeFile(source, csv);
    await service.importFile(source, { pageId: "measurements" });
    const removedInactive = await service.remove(inactive);
    expect(removedInactive.removedPlatformId).toBe(inactive);
    expect(removedInactive.activePlatformId).toBe(active);
    expect(removedInactive.platforms.map((entry) => entry.id)).toEqual(expect.arrayContaining([active, retained]));
    expect((await new PlatformService(options).state()).activePlatformId).toBe(active);
    const removedActive = await service.remove(active);
    expect(removedActive.activePlatformId).toBeNull();
    expect(removedActive.snapshot).toBeNull();
    expect(removedActive.platforms.map((entry) => entry.id)).toEqual([retained]);
    const archive = JSON.parse(await fs.readFile(path.join(removedActive.archivePath, "snapshot.json"), "utf8"));
    expect(archive.records).toHaveLength(5);
    expect(await fs.readFile(path.join(removedActive.archivePath, archive.assets[0].relativePath), "utf8")).toBe(csv);
    expect(await fs.readFile(source, "utf8")).toBe(csv);
    const reloaded = new PlatformService(options);
    expect((await reloaded.state()).activePlatformId).toBeNull();
    expect((await reloaded.select(retained)).snapshot.definition.name).toBe("其他保留平台");
    const empty = await reloaded.remove(retained);
    expect(empty.platforms).toEqual([]);
    expect(empty.activePlatformId).toBeNull();
  }));

  it("serializes disabling and deletion across service instances without re-enabling a platform", async () => sandbox(async ({ service, options }) => {
    const first = await service.create(definition()), inactive = first.activePlatformId;
    const second = await service.create({ ...definition(), name: "保留的平台" }), retained = second.activePlatformId;
    await Promise.all([service.select(null), new PlatformService(options).remove(inactive)]);
    const state = await new PlatformService(options).state();
    expect(state.activePlatformId).toBeNull();
    expect(state.platforms.map((entry) => entry.id)).toEqual([retained]);
    expect((await service.select(retained)).activePlatformId).toBe(retained);
  }));

  it("previews custom fields without saving and computes imported labelled CSV with three sample units", async () => sandbox(async ({ root, service }) => {
    const preview = await service.preview({ requirement: "平台名称：我的检测台；字段：样品编号、批次、温度(°C)、读数(mg/g)。添加统计分析。" });
    expect(preview.mode).toBe("local");
    expect(preview.definition.name).toBe("我的检测台");
    expect(preview.definition.pages[0].fields.map((field) => field.label)).toEqual(["样品编号", "批次", "温度", "读数"]);
    expect((await service.state()).platforms).toEqual([]);
    const created = await service.create({ definition: definition() });
    expect(created.snapshot.definition.id).toBe(created.activePlatformId);
    expect(created.modelConnections).toHaveLength(1);
    const source = path.join(root, "读数.csv"); await fs.writeFile(source, csv);
    const imported = await service.importFile(source, { pageId: "measurements" });
    expect(imported.snapshot.records).toHaveLength(5);
    expect(imported.warnings).toContain("未导入未配置的列：额外列");
    expect(imported.snapshot.records[4].values.response).toBeNull();
    const analyzed = await service.analyze(analysisOptions), run = analyzed.snapshot.runs[0];
    expect(run.result.rows[0]).toMatchObject({ n: 3, readings: 4, mean: (12 + 20 + 30) / 3 });
    expect(run.result.missing).toBe(1);
    expect(run.assetIds).toEqual([imported.snapshot.assets[0].id]);
    expect(run.sources).toEqual(["imported"]);
  }));

  it("archives original bytes and exports the preserved source even after the selected file changes", async () => sandbox(async ({ root, service, exports }) => {
    await service.create(definition());
    const source = path.join(root, "data.csv"); await fs.writeFile(source, csv);
    const state = await service.importFile(source, { pageId: "measurements" }), asset = state.snapshot.assets[0];
    expect(asset.sha256).toBe(createHash("sha256").update(csv).digest("hex"));
    await fs.writeFile(source, "replaced at source");
    const archived = await service.assetLocation(asset.id);
    expect(await fs.readFile(archived.path, "utf8")).toBe(csv);
    const exported = await service.export(exports);
    expect(await fs.readFile(path.join(exported, asset.relativePath), "utf8")).toBe(csv);
    await fs.writeFile(archived.path, "altered archived evidence");
    await expect(service.assetLocation(asset.id)).rejects.toThrow("校验失败");
  }));

  it("keeps user, example and imported sources distinct and shares only configuration in templates", async () => sandbox(async ({ root, service, options }) => {
    await service.create(definition());
    await service.record({ pageId: "measurements", values: { specimen: "manual", response: 0 } });
    await service.record({ pageId: "measurements", values: { specimen: "demo", response: 9 }, source: "example" });
    const source = path.join(root, "single.csv"); await fs.writeFile(source, "样品编号,吸附响应\nimported,12\n");
    const state = await service.importFile(source, { pageId: "measurements" });
    expect(state.snapshot.records.map((record) => record.source)).toEqual(["user", "example", "imported"]);
    const analyzed = await service.analyze(analysisOptions);
    expect(analyzed.snapshot.runs[0].warnings.join(" ")).toContain("示例数据");
    const template = path.join(root, "my-platform.json"); await service.templateExport(template);
    const payload = JSON.parse(await fs.readFile(template, "utf8"));
    expect(payload.definition.id).toBeUndefined();
    expect(payload.records).toBeUndefined();
    expect(payload.definition.pages[0].fields[2].unit).toBe("mg/g");
    const restored = await new PlatformService(options).templateImport(template);
    expect(restored.platforms).toHaveLength(2);
    expect(restored.snapshot.definition.id).not.toBe(state.activePlatformId);
    expect(restored.snapshot.records).toEqual([]);
    expect(restored.snapshot.assets).toEqual([]);
    expect(restored.snapshot.runs).toEqual([]);
    const bareDefinition = path.join(root, "definition.json");
    await fs.writeFile(bareDefinition, JSON.stringify(state.snapshot.definition));
    const importedBare = await service.templateImport(bareDefinition);
    expect(importedBare.snapshot.definition.id).not.toBe(state.activePlatformId);
    expect(importedBare.snapshot.records).toEqual([]);
  }));

  it("revises names and removes fields without deleting data and rejects outdated configuration", async () => sandbox(async ({ service, options }) => {
    const initial = await service.create(definition());
    await service.record({ pageId: "measurements", values: { specimen: "a", response: 2, memo: "原始观察" } });
    const revised = definition(); revised.name = "重新命名的平台"; revised.pages[0].fields = revised.pages[0].fields.filter((field) => field.id !== "memo");
    const state = await service.revise({ id: initial.activePlatformId, definition: revised, expectedVersion: 1 });
    expect(state.snapshot.definitionVersion).toBe(2);
    expect(state.snapshot.records[0].values.memo).toBe("原始观察");
    expect(state.snapshot.archivedFields[0].id).toBe("memo");
    await expect(service.revise({ id: initial.activePlatformId, definition: definition(), expectedVersion: 1 })).rejects.toThrow("刷新");
    const restored = await service.restore({ version: 1 });
    expect(restored.snapshot.definitionVersion).toBe(3);
    expect(restored.snapshot.history).toHaveLength(3);
    expect((await new PlatformService(options).state()).snapshot.records[0].values.memo).toBe("原始观察");
  }));

  it("executes each workflow step and saves real analysis, report and completed execution evidence", async () => sandbox(async ({ root, service }) => {
    const created = await service.create(definition());
    const source = path.join(root, "workflow.csv"); await fs.writeFile(source, csv);
    let entered, release;
    const picking = new Promise((resolve) => { entered = resolve; });
    const selected = new Promise((resolve) => { release = resolve; });
    const running = service.runWorkflow({ workflowId: "review" }, async () => { entered(); return selected; });
    await picking;
    await expect(service.revise({ id: created.activePlatformId, definition: definition(), expectedVersion: 1 })).rejects.toThrow("流程正在运行");
    await expect(service.restore({ version: 1 })).rejects.toThrow("流程正在运行");
    await expect(service.remove(created.activePlatformId)).rejects.toThrow("流程正在运行");
    await expect(service.runWorkflow({ workflowId: "review" }, async () => source)).rejects.toThrow("已有流程正在运行");
    release(source);
    const state = await running;
    expect(state.snapshot.runs.map((run) => run.kind)).toEqual(["descriptive-statistics", "report", "workflow"]);
    const [analysis, report, execution] = state.snapshot.runs;
    expect(analysis.result.rows[0].n).toBe(3);
    expect(report.sourceRunIds).toEqual([analysis.id]);
    expect(report.result.body).toContain("3 个样品编号");
    expect(execution.status).toBe("completed");
    expect(execution.stepResults.map((step) => step.step)).toEqual(["import", "analyze", "report"]);
    expect(execution.stepResults[1].runId).toBe(analysis.id);
    expect(execution.stepResults[2].runId).toBe(report.id);
    expect(state.snapshot.definitionVersion).toBe(1);
  }));

  it("keeps completed import and failure or cancellation logs without claiming an analysis ran", async () => sandbox(async ({ root, service }) => {
    const noStats = definition(); noStats.capabilities = noStats.capabilities.filter((entry) => entry !== "statistics");
    await service.create(noStats);
    const source = path.join(root, "failed-workflow.csv"); await fs.writeFile(source, csv);
    await expect(service.runWorkflow({ workflowId: "review" }, async () => source)).rejects.toThrow("启用统计");
    const failed = (await service.state()).snapshot;
    expect(failed.records).toHaveLength(5);
    expect(failed.runs).toHaveLength(1);
    expect(failed.runs[0]).toMatchObject({ kind: "workflow", status: "failed" });
    expect(failed.runs[0].stepResults.map((step) => step.step)).toEqual(["import"]);
    await expect(service.runWorkflow({ workflowId: "review" }, async () => null)).rejects.toThrow("已取消");
    expect((await service.state()).snapshot.runs.at(-1).status).toBe("cancelled");
    const noFiles = definition(); noFiles.capabilities = [];
    await service.revise({ id: failed.definition.id, definition: noFiles, expectedVersion: 1 });
    await expect(service.importFile(source, { pageId: "measurements" })).rejects.toThrow("启用文件");
    expect((await service.state()).snapshot.assets).toHaveLength(1);
    await service.record({ pageId: "measurements", values: { specimen: "manual-still-available", response: 0 } });
    expect((await service.state()).snapshot.records).toHaveLength(6);
  }));

  it("uses defaults from the workflow source page and keeps report inputs on that page", async () => sandbox(async ({ service }) => {
    const configured = definition();
    configured.pages.push({ id: "second", title: "第二种测量", kind: "records", fields: [{ id: "specimen2", label: "样品", type: "text" }, { id: "response2", label: "另一响应", type: "number" }] },
      { id: "analysis2", title: "第二分析", kind: "analysis", sourcePageId: "second", valueField: "response2", sampleField: "specimen2" });
    configured.workflows.push({ id: "second_workflow", title: "第二页流程", sourcePageId: "second", steps: ["analyze", "report"] },
      { id: "report_only", title: "第二页报告", sourcePageId: "second", steps: ["report"] });
    await service.create(configured);
    await service.record({ pageId: "measurements", values: { specimen: "a", response: 900 } });
    await service.record({ pageId: "second", values: { specimen2: "b", response2: 5 } });
    await service.analyze(analysisOptions);
    await expect(service.runWorkflow({ workflowId: "report_only" })).rejects.toThrow("对应的分析结果");
    const completed = await service.runWorkflow({ workflowId: "second_workflow" });
    const secondAnalysis = completed.snapshot.runs.find(run => run.kind === "descriptive-statistics" && run.config.pageId === "second");
    expect(secondAnalysis.result.rows[0].mean).toBe(5);
    expect(secondAnalysis.config).toMatchObject({ pageId: "second", valueField: "response2", sampleField: "specimen2" });
    expect(completed.snapshot.runs.find(run => run.kind === "report").sourceRunIds).toEqual([secondAnalysis.id]);
    const reported = await service.runWorkflow({ workflowId: "report_only" });
    expect(reported.snapshot.runs.filter(run => run.kind === "report").at(-1).sourceRunIds).toEqual([secondAnalysis.id]);
  }));

  it("does not report an old analysis as the result of freshly imported data", async () => sandbox(async ({ root, service }) => {
    const configured = definition(); configured.workflows.push({ ...configured.workflows[0], id: "skip_analysis", steps: ["import", "report"] });
    await service.create(configured);
    await service.record({ pageId: "measurements", values: { specimen: "old", response: 5 } });
    await service.analyze(analysisOptions);
    const source = path.join(root, "new-data.csv"); await fs.writeFile(source, csv);
    await expect(service.runWorkflow({ workflowId: "skip_analysis" }, async () => source)).rejects.toThrow("尚未分析");
    const state = await service.state();
    expect(state.snapshot.runs.filter(run => run.kind === "report")).toHaveLength(0);
    expect(state.snapshot.records).toHaveLength(6);
    expect(state.snapshot.runs.at(-1)).toMatchObject({ status: "failed", stepResults: [{ step: "import", records: 5 }] });
  }));

  it("applies an Agent proposal once across service instances and accepts proposal-only confirmation", async () => sandbox(async ({ workspace, service, options }) => {
    const proposal = await platformProposeTool(workspace, { definition: definition(), reason: "按用户字段搭建" });
    expect((await service.state()).platforms).toHaveLength(0);
    const outcomes = await Promise.allSettled([service.create({ proposalId: proposal.id }), new PlatformService(options).create({ proposalId: proposal.id })]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const applied = await getPlatformProposal(workspace, proposal.id);
    expect(applied.status).toBe("applied");
    expect((await service.state()).platforms).toHaveLength(1);
    expect((await service.state()).activePlatformId).toBe(applied.appliedPlatformId);
  }));

  it("rejects a proposal target or version mismatch before changing any platform", async () => sandbox(async ({ workspace, service }) => {
    const first = await service.create(definition());
    const second = await service.create({ ...definition(), name: "第二个平台" });
    const proposal = await platformProposeTool(workspace, { platformId: first.activePlatformId, expectedVersion: 1, definition: { ...definition(), name: "已审查修改" } });
    await expect(service.revise({ id: second.activePlatformId, definition: { ...definition(), name: "不应保存" }, expectedVersion: 1, proposalId: proposal.id })).rejects.toThrow("不一致");
    expect((await service.state()).snapshot.definition).toMatchObject({ name: "第二个平台" });
    expect((await service.state()).snapshot.definitionVersion).toBe(1);
    await expect(service.revise({ id: first.activePlatformId, definition: proposal.definition, expectedVersion: 2, proposalId: proposal.id })).rejects.toThrow("版本不一致");
    expect((await getPlatformProposal(workspace, proposal.id)).status).toBe("draft");
    const applied = await service.revise({ id: first.activePlatformId, definition: proposal.definition, expectedVersion: 1, proposalId: proposal.id });
    expect(applied.snapshot.definition.name).toBe("已审查修改");
    expect(applied.snapshot.definitionVersion).toBe(2);
    const fresh = await platformProposeTool(workspace, { definition: definition() });
    await expect(service.revise({ id: first.activePlatformId, definition: fresh.definition, expectedVersion: 2, proposalId: fresh.id })).rejects.toThrow("不一致");
    expect((await service.state()).snapshot.definitionVersion).toBe(2);
  }));

  it("imports XLSX numeric/date values and rejects formula cells while retaining their original file", async () => sandbox(async ({ root, service }) => {
    const configured = definition(); configured.pages[0].fields.push({ id: "date", label: "采样日期", type: "date" });
    await service.create(configured);
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("样品");
    sheet.addRow(["样品编号", "吸附响应", "采样日期"]); sheet.addRow(["x", 0, new Date("2026-10-14T00:00:00.000Z")]);
    const source = path.join(root, "读数.xlsx"); await workbook.xlsx.writeFile(source);
    const imported = await service.importFile(source, { pageId: "measurements" });
    expect(imported.snapshot.records[0].values).toMatchObject({ specimen: "x", response: 0, date: "2026-10-14" });
    sheet.getCell("B2").value = { formula: "1+1", result: 2 }; await workbook.xlsx.writeFile(source);
    await expect(service.importFile(source, { pageId: "measurements" })).rejects.toThrow("公式");
    const failed = await service.state();
    expect(failed.snapshot.records).toHaveLength(1);
    expect(failed.snapshot.assets).toHaveLength(2);
  }));
});
