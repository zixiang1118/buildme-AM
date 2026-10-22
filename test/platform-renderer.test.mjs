import { readFile } from "node:fs/promises";
import console from "node:console";
import { URL } from "node:url";
import { setTimeout } from "node:timers";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

const code = await readFile(new URL("../desktop/renderer/platforms.js", import.meta.url), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
const definition = {
  schemaVersion: 1, id: "p1", name: "自定义实验台", description: "比较各组检测值",
  pages: [{ id: "data", title: "我的记录", kind: "records", fields: [{ id: "sample", label: "样本", type: "text" }, { id: "value", label: "检测值", type: "number", unit: "mg/L" }] }, { id: "analysis", title: "数据对比", kind: "analysis", fields: [], sourcePageId: "data", valueField: "value", sampleField: "sample" }],
  capabilities: ["records", "files", "statistics", "charts"], assistant: { role: "实验助手", instructions: "区分记录与预测" }, workflows: [{ id: "flow", title: "导入与分析", steps: ["import", "analyze", "report"] }],
};
const stored = () => ({ platforms: [{ id: "p1", name: definition.name, version: 2 }], activePlatformId: "p1", snapshot: { definition: copy(definition), definitionVersion: 2, records: [{ id: "r1", pageId: "data", values: { sample: "A", value: 12 }, source: "user" }], runs: [], assets: [], history: [{ version: 1, createdAt: "2026-10-14T00:00:00Z" }] } });

async function fixture(initial = stored(), overrides = {}) {
  const { document, window } = parseHTML("<!doctype html><html><body><div class='app-shell'></div></body></html>");
  const selectProto = Object.getPrototypeOf(document.createElement("select"));
  Object.defineProperty(selectProto, "value", { configurable: true, get() { return this.__value ?? [...this.options].find(o => o.selected)?.value ?? this.firstChild?.value ?? ""; }, set(value) { this.__value = value; for (const option of this.options) option.selected = option.value === value; } });
  const elementProto = window.HTMLElement.prototype;
  elementProto.focus = function () { this.dataset.focused = "true"; };
  elementProto.showModal = function () { this.open = true; };
  elementProto.close = function () { this.open = false; };
  let state = initial;
  const api = {
    platformState: vi.fn(async () => state), platformSelect: vi.fn(async () => state), platformDelete: vi.fn(async () => state),
    platformCreate: vi.fn(async d => { state = { ...stored(), snapshot: { ...stored().snapshot, definition: d, definitionVersion: 1 } }; return state; }),
    platformRevise: vi.fn(async payload => { state = { ...state, snapshot: { ...state.snapshot, definition: payload.definition, definitionVersion: 3 } }; return state; }),
    platformRecord: vi.fn(async () => state), platformImport: vi.fn(async () => state), platformAnalyze: vi.fn(async () => state),
    platformRunWorkflow: vi.fn(async () => state), platformPrompt: vi.fn(async () => ({ prompt: "请搭建我的平台" })),
    platformRestore: vi.fn(async () => state), ...overrides,
  };
  const onPrompt = vi.fn(), onSwitchMode = vi.fn(async () => false), onState = vi.fn(), onReady = vi.fn();
  vm.runInNewContext(code, { window, document, console, JSON, Math, Number, String, Object, Map, Set, Date });
  const ui = window.createPlatforms(api, { onPrompt, onSwitchMode, onState, onReady });
  await ui.open(state);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const click = async label => { const target = [...document.querySelectorAll("button")].find(b => b.textContent === label); if (!target) throw new Error(`Missing button ${label}`); target.click(); await settle(); return target; };
  const input = (label, value) => { const target = document.querySelector(`[aria-label='${label}']`); if (!target) throw new Error(`Missing input ${label}`); target.value = value; target.dispatchEvent(new window.Event("input")); return target; };
  const submit = async () => { document.querySelector("dialog form").dispatchEvent(new window.Event("submit", { cancelable: true })); await settle(); };
  return { document, window, api, ui, click, input, submit, settle, onPrompt, onSwitchMode, onState, onReady };
}

describe("custom research platform renderer", () => {
  it("disables the selected platform and can select it again without removing it", async () => {
    const active = stored(), disabled = { ...active, activePlatformId: null, snapshot: null };
    const f = await fixture(active, { platformSelect: vi.fn(async id => id === null ? disabled : active) });
    const picker = f.document.querySelector(".platform-picker");
    expect(picker.options[0].textContent).toBe("不启用平台");
    picker.value = ""; picker.dispatchEvent(new f.window.Event("change")); await f.settle();
    expect(f.api.platformSelect).toHaveBeenCalledWith(null);
    expect(f.document.querySelector(".platform-picker").value).toBe("");
    expect(f.document.querySelectorAll(".platform-platform-grid [data-platform-id]")).toHaveLength(1);
    expect(f.onState).toHaveBeenLastCalledWith(disabled);
    await f.click("打开使用");
    expect(f.api.platformSelect).toHaveBeenLastCalledWith("p1");
    expect(f.document.querySelector(".platform-heading h1").textContent).toBe(definition.name);
    expect(f.onState).toHaveBeenLastCalledWith(active);
  });

  it("only deletes after confirmation and updates the selected platform state", async () => {
    const removed = { platforms: [], activePlatformId: null, snapshot: null };
    const f = await fixture(stored(), { platformDelete: vi.fn(async () => removed) });
    await f.click("删除平台");
    expect(f.api.platformDelete).not.toHaveBeenCalled();
    expect(f.document.querySelector("dialog").textContent).toContain("删除后将停用平台");
    await f.click("取消");
    expect(f.api.platformDelete).not.toHaveBeenCalled();
    expect(f.document.querySelector('[data-platform-id="p1"]')).not.toBeNull();
    await f.click("删除平台"); await f.submit();
    expect(f.api.platformDelete).toHaveBeenCalledExactlyOnceWith("p1");
    expect(f.document.querySelector('[data-platform-id="p1"]')).toBeNull();
    expect(f.onState).toHaveBeenLastCalledWith(removed);
    expect(f.document.querySelector(".platform-notice").textContent).toContain("研究数据已保留");
  });

  it("keeps the platform and confirmation open when deletion fails", async () => {
    const f = await fixture(stored(), { platformDelete: vi.fn(async () => { throw new Error("平台流程正在运行"); }) });
    await f.click("删除平台"); await f.submit();
    expect(f.document.querySelector("dialog").open).toBe(true);
    expect(f.document.querySelector(".platform-dialog-error").textContent).toBe("平台流程正在运行");
    expect(f.document.querySelector('[data-platform-id="p1"]')).not.toBeNull();
  });

  it("lets users create a named platform and add editable fields before saving", async () => {
    const f = await fixture({ platforms: [], snapshot: null });
    await f.click("＋ 搭建新平台");
    f.input("平台名称", "土壤监测工作台");
    await f.click("页面与字段");
    await f.click("＋ 添加页面");
    await f.click("＋ 添加字段");
    const fields = f.document.querySelectorAll("[aria-label='字段名称']");
    fields[fields.length - 1].value = "检测浓度"; fields[fields.length - 1].dispatchEvent(new f.window.Event("input"));
    await f.click("保存并进入对话");
    expect(f.document.querySelector('dialog button[type="submit"]').textContent).toBe("保存并进入对话");
    expect(f.ui.isOpen()).toBe(true);
    expect(f.onReady).not.toHaveBeenCalled();
    await f.submit();
    expect(f.api.platformCreate).toHaveBeenCalledTimes(1);
    expect(f.api.platformCreate.mock.calls[0][0].name).toBe("土壤监测工作台");
    expect(f.api.platformCreate.mock.calls[0][0].pages[0].fields.at(-1).label).toBe("检测浓度");
    const saved = await f.api.platformCreate.mock.results[0].value;
    expect(f.document.querySelector(".platform-panel").hidden).toBe(true);
    expect(f.document.querySelector(".app-shell").inert).toBe(false);
    expect(f.onState).toHaveBeenLastCalledWith(saved);
    expect(f.onReady).toHaveBeenCalledExactlyOnceWith(saved.snapshot);
    await f.ui.open();
    expect(f.document.querySelector(".platform-page").textContent).toContain("土壤监测工作台");
  });

  it("uses stored definitionVersion for a revision and does not rewrite record values", async () => {
    const f = await fixture(); await f.click("继续搭建");
    await f.click("移除");
    await f.click("保存变更并进入对话");
    expect(f.document.querySelector("dialog").textContent).toContain("旧值仍保留");
    await f.submit();
    expect(f.api.platformRevise.mock.calls[0][0].expectedVersion).toBe(2);
    expect(f.api.platformRecord).not.toHaveBeenCalled();
    const saved = await f.api.platformRevise.mock.results[0].value;
    expect(saved.snapshot.records).toEqual(stored().snapshot.records);
    expect(f.document.querySelector(".platform-panel").hidden).toBe(true);
    expect(f.document.querySelector(".app-shell").inert).toBe(false);
    expect(f.onReady).toHaveBeenCalledExactlyOnceWith(saved.snapshot);
  });

  it.each(["create", "revise"])("keeps the builder and confirmation open if %s fails", async operation => {
    const method = operation === "create" ? "platformCreate" : "platformRevise";
    const f = await fixture(operation === "create" ? { platforms: [], snapshot: null } : stored(), {
      [method]: vi.fn(async () => { throw new Error("平台保存失败，请重试"); }),
    });
    if (operation === "create") {
      await f.click("＋ 搭建新平台");
      await f.click("页面与字段");
      await f.click("＋ 添加页面");
    } else await f.click("继续搭建");
    f.input("平台名称", "保留未保存的设计");
    f.onState.mockClear();
    await f.click(operation === "create" ? "保存并进入对话" : "保存变更并进入对话");
    await f.submit();
    expect(f.api[method]).toHaveBeenCalledTimes(1);
    expect(f.ui.isOpen()).toBe(true);
    expect(f.document.querySelector(".platform-panel").hidden).toBe(false);
    expect(f.document.querySelector(".app-shell").inert).toBe(true);
    expect(f.document.querySelector("dialog").open).toBe(true);
    expect(f.document.querySelector(".platform-dialog-error").textContent).toBe("平台保存失败，请重试");
    expect(f.document.querySelector('[aria-label="平台名称"]').value).toBe("保留未保存的设计");
    expect(f.onReady).not.toHaveBeenCalled();
    expect(f.onState).not.toHaveBeenCalled();
  });

  it("retains null number values and explicitly records a source", async () => {
    const f = await fixture(); await f.click("打开使用"); await f.click("我的记录"); await f.click("＋ 新增记录");
    f.input("样本", "B"); f.input("检测值 (mg/L)", ""); await f.submit();
    expect(f.api.platformRecord.mock.calls[0][0]).toEqual({ pageId: "data", values: { sample: "B", value: null }, source: "user" });
  });

  it("runs workflow through the service and displays its saved execution records", async () => {
    const state = stored();
    const f = await fixture(state, { platformRunWorkflow: vi.fn(async () => ({ ...state, snapshot: { ...state.snapshot, runs: [{ id: "run1", kind: "workflow", status: "completed", result: { summary: "均值 12", steps: ["import", "analyze", "report"] } }] } })) });
    await f.click("打开使用"); await f.click("运行流程");
    expect(f.api.platformRunWorkflow).toHaveBeenCalledWith({ workflowId: "flow" });
    expect(f.document.querySelector(".platform-page").textContent).toContain("均值 12");
  });

  it("binds individual workflow import and analysis steps to their second record page and explicit fields", async () => {
    const state = stored();
    state.snapshot.definition.pages.push({ id: "second", title: "另一组实验记录", kind: "records", fields: [
      { id: "response", label: "默认响应", type: "number" }, { id: "alternate", label: "流程响应", type: "number" },
      { id: "batch", label: "批次", type: "text" }, { id: "unit", label: "独立样本", type: "text" },
      { id: "phase", label: "默认分组", type: "text" }, { id: "sample2", label: "默认样本", type: "text" },
    ] }, { id: "second_analysis", title: "另一组数据分析", kind: "analysis", sourcePageId: "second", valueField: "response", groupField: "phase", sampleField: "sample2" });
    state.snapshot.definition.workflows[0] = { id: "flow", title: "另一组的流程", sourcePageId: "second", valueField: "alternate", groupField: "batch", sampleField: "unit", steps: ["import", "analyze", "report"] };
    const f = await fixture(state); await f.click("打开使用");
    expect(f.document.querySelector(".platform-flow").textContent).toContain("数据来源：另一组实验记录");
    expect(f.document.querySelector(".platform-flow").textContent).toContain("数值：流程响应");
    await f.click("1. 导入文件");
    expect(f.api.platformImport).toHaveBeenCalledExactlyOnceWith({ pageId: "second" });
    expect(f.document.querySelector(".platform-heading h1").textContent).toBe("另一组实验记录");
    await f.click("我的平台"); await f.click("打开使用"); await f.click("2. 运行分析");
    expect(f.api.platformAnalyze).toHaveBeenCalledExactlyOnceWith({ pageId: "second", valueField: "alternate", groupField: "batch", sampleField: "unit" });
    expect(f.document.querySelector(".platform-heading h1").textContent).toBe("另一组数据分析");
    expect(f.document.querySelector("[aria-label='数值字段']").value).toBe("alternate");
    expect(f.document.querySelector("[aria-label='分组字段']").value).toBe("batch");
    expect(f.document.querySelector("[aria-label='样本编号字段']").value).toBe("unit");
  });

  it("uses analysis defaults only from the workflow source and reports missing numeric configuration", async () => {
    const state = stored();
    state.snapshot.definition.pages.push({ id: "second", title: "第二记录页", kind: "records", fields: [{ id: "score", label: "评分", type: "number" }, { id: "sample2", label: "样本编号", type: "text" }] },
      { id: "second_analysis", title: "第二分析页", kind: "analysis", sourcePageId: "second", valueField: "score", sampleField: "sample2" });
    state.snapshot.definition.workflows[0].sourcePageId = "second";
    const f = await fixture(state); await f.click("打开使用"); await f.click("2. 运行分析");
    expect(f.api.platformAnalyze).toHaveBeenCalledExactlyOnceWith({ pageId: "second", valueField: "score", sampleField: "sample2" });
    const missing = copy(state); delete missing.snapshot.definition.pages.at(-1).valueField; missing.snapshot.definition.pages.find(p => p.id === "second").fields[0].type = "text";
    const missingFixture = await fixture(missing); await missingFixture.click("打开使用"); await missingFixture.click("2. 运行分析");
    expect(missingFixture.api.platformAnalyze).not.toHaveBeenCalled();
    expect(missingFixture.document.querySelector(".platform-notice").textContent).toContain("没有有效的数值字段");
  });

  it("falls back to its source's first numeric field without borrowing another analysis page's fields", async () => {
    const state = stored();
    state.snapshot.definition.pages.push({ id: "second", title: "没有专属分析页的记录", kind: "records", fields: [{ id: "score", label: "评分", type: "number" }] });
    state.snapshot.definition.workflows[0].sourcePageId = "second";
    const f = await fixture(state); await f.click("打开使用"); await f.click("2. 运行分析");
    expect(f.api.platformAnalyze).toHaveBeenCalledExactlyOnceWith({ pageId: "second", valueField: "score" });
    expect(f.document.querySelector(".platform-heading h1").textContent).toBe("没有专属分析页的记录");
    const matching = copy(state); matching.snapshot.definition.pages.push({ id: "second_analysis", title: "未设默认值的分析页", kind: "analysis", sourcePageId: "second" });
    const g = await fixture(matching); await g.click("打开使用"); await g.click("2. 运行分析");
    expect(g.api.platformAnalyze).toHaveBeenCalledExactlyOnceWith({ pageId: "second", valueField: "score" });
    expect(g.document.querySelector("[aria-label='样本编号字段']").value).toBe("");
  });

  it("does not interpret a different page's analysis as a workflow report", async () => {
    const state = stored();
    state.snapshot.definition.pages.push({ id: "second", title: "第二记录页", kind: "records", fields: [{ id: "score", label: "评分", type: "number" }] }, { id: "second_analysis", title: "第二分析页", kind: "analysis", sourcePageId: "second", valueField: "score" });
    state.snapshot.definition.workflows[0].sourcePageId = "second";
    state.snapshot.runs = [{ id: "first-analysis", kind: "descriptive-statistics", config: { pageId: "data", valueField: "value", sampleField: "sample" } }];
    const f = await fixture(state); await f.click("打开使用"); await f.click("3. 准备结果解读");
    expect(f.api.platformPrompt).not.toHaveBeenCalled();
    expect(f.document.querySelector(".platform-notice").textContent).toContain("还没有对应分析记录");
    const matched = copy(state); matched.snapshot.runs.push({ id: "second-analysis", kind: "descriptive-statistics", config: { pageId: "second", valueField: "score" } });
    const g = await fixture(matched); await g.click("打开使用"); await g.click("3. 准备结果解读");
    expect(g.api.platformPrompt.mock.calls[0][0]).toMatchObject({ task: "interpret" });
    expect(g.api.platformPrompt.mock.calls[0][0].requirement).toContain("second-analysis");
    expect(g.api.platformPrompt.mock.calls[0][0].requirement).not.toContain("first-analysis");
  });

  it("renders the real statistics contract and retains the ungrouped selection", async () => {
    const state = stored(); state.snapshot.definition.pages[1].groupField = "sample";
    const run = { id: "analysis1", kind: "descriptive-statistics", config: { pageId: "data", valueField: "value" }, inputs: copy(state.snapshot.records), inputHashes: [{ recordId: "r1", sha256: "hash" }], result: { rows: [{ label: "全部记录", group: "全部记录", n: 1, readings: 2, mean: 12, sd: null, median: 12, min: 12, max: 12 }], points: [{ recordId: "r1", sampleId: "A", group: "全部记录", value: 12, source: "user" }], summary: { field: "检测值", unit: "mg/L" }, warnings: ["缺失数据未补成零"] } };
    const f = await fixture(state, { platformAnalyze: vi.fn(async () => ({ ...state, snapshot: { ...state.snapshot, runs: [run] } })) });
    await f.click("打开使用"); await f.click("数据对比");
    f.input("分组字段", ""); await f.click("运行分析");
    expect(f.api.platformAnalyze.mock.calls[0][0]).toEqual({ pageId: "data", valueField: "value", sampleField: "sample" });
    expect(f.document.querySelector("[aria-label='分组字段']").value).toBe("");
    expect(f.document.querySelector(".platform-page").textContent).toContain("检测值 (mg/L)");
    expect(f.document.querySelector(".platform-chart circle")).not.toBeNull();
    expect(f.document.querySelector(".platform-page").textContent).toContain("缺失数据未补成零");
    await f.click("查看输入与运行过程"); expect(f.document.querySelector(".platform-page").textContent).toContain('"inputHashes"');
  });

  it("handles analysis pages without fields and cleans fields when changing page kind", async () => {
    const state = stored(); delete state.snapshot.definition.pages[1].fields;
    const f = await fixture(state); await f.click("继续搭建"); await f.click("数据对比");
    f.input("页面类型", "records"); await f.click("＋ 添加字段");
    f.input("页面类型", "analysis"); await f.click("保存变更并进入对话"); await f.submit();
    expect(f.api.platformRevise.mock.calls[0][0].definition.pages[1].fields).toEqual([]);
  });

  it("keeps Agent proposals unapplied until reviewed and saved", async () => {
    const state = stored(); state.proposals = [{ id: "proposal", definition: { ...copy(definition), name: "Agent 的调整" }, platformId: "p1", expectedVersion: 2, reason: "新增实验字段" }];
    const f = await fixture(state); await f.click("查看并继续搭建");
    expect(f.api.platformCreate).not.toHaveBeenCalled(); expect(f.api.platformRevise).not.toHaveBeenCalled();
    await f.click("保存变更并进入对话"); await f.submit();
    expect(f.api.platformRevise.mock.calls[0][0]).toMatchObject({ id: "p1", expectedVersion: 2, definition: { name: "Agent 的调整" } });
  });

  it("switches through the shared mode handler and renders untrusted names as text", async () => {
    const state = stored(); state.platforms[0].name = "<img src=x onerror=alert(1)>";
    const f = await fixture(state); expect(f.document.querySelector(".platform-page img")).toBeNull();
    await f.click("科研版 ⌄"); f.document.querySelector("[data-mode='learning']").click(); await f.settle();
    expect(f.onSwitchMode).toHaveBeenCalledWith("learning"); expect(f.ui.isOpen()).toBe(true);
    f.ui.close(); expect(f.document.querySelector(".app-shell").inert).toBe(false);
  });
});
