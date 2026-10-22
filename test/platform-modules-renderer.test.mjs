import { readFile } from "node:fs/promises";
import console from "node:console";
import vm from "node:vm";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { RESEARCH_MODULES, composeModuleDefinition, validateResearchModule } from "../desktop/platform-modules.mjs";
import { validateDefinition } from "../desktop/platform-store.mjs";

const code = await readFile(new URL("../desktop/renderer/platforms.js", import.meta.url), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
const ids = ["datasets", "code", "comparison", "reports", "samples", "protocols", "experiments", "analysis", "search", "screening", "writing"];
const titles = ["数据集管理", "代码运行", "实验比较", "图表与报告", "样本管理", "实验方案", "实验记录", "数据分析", "检索记录", "文献筛选", "综合写作"];
const emptyState = () => ({ platforms: [], snapshot: null, activePlatformId: null, moduleCatalog: copy(RESEARCH_MODULES) });
const base = () => ({ schemaVersion: 1, name: "组合工作台", description: "", pages: [], capabilities: [], modules: [], assistant: { role: "科研助手", instructions: "保留数据来源" }, workflows: [] });
const savedState = definition => ({ ...emptyState(), activePlatformId: "p1", platforms: [{ id: "p1", name: definition.name, version: 2 }], snapshot: { definition: { ...copy(definition), id: "p1" }, definitionVersion: 2, records: [], runs: [], assets: [], history: [] } });

async function fixture(initial = emptyState(), overrides = {}) {
  const { document, window } = parseHTML("<!doctype html><html><body><div class='app-shell'></div></body></html>");
  const selectProto = Object.getPrototypeOf(document.createElement("select"));
  Object.defineProperty(selectProto, "value", { configurable: true, get() { return this.__value ?? [...this.options].find(o => o.selected)?.value ?? this.firstChild?.value ?? ""; }, set(value) { this.__value = value; for (const option of this.options) option.selected = option.value === value; } });
  window.HTMLElement.prototype.focus = function () { this.dataset.focused = "true"; };
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; };
  let state = copy(initial);
  const api = {
    platformState: vi.fn(async () => state), platformSelect: vi.fn(async () => state),
    platformCreate: vi.fn(async definition => { state = savedState(validateDefinition(definition)); return state; }),
    platformRevise: vi.fn(async payload => { state = { ...state, snapshot: { ...state.snapshot, definition: validateDefinition(payload.definition), definitionVersion: 3 } }; return state; }),
    platformRecord: vi.fn(async () => state), platformAnalyze: vi.fn(async () => state), platformImport: vi.fn(async () => state),
    platformModuleSave: vi.fn(async input => {
      const savedModule = validateResearchModule(copy(input));
      state = { ...state, moduleCatalog: [...state.moduleCatalog.filter(spec => spec.id !== savedModule.id), savedModule], savedModule };
      return state;
    }),
    platformModuleGenerate: vi.fn(async () => { throw new Error("请先配置模型连接"); }),
    ...overrides,
  };
  vm.runInNewContext(code, { window, document, console, JSON, Math, Number, String, Object, Map, Set, Date });
  const onReady = vi.fn();
  const ui = window.createPlatforms(api, { onReady });
  await ui.open(state);
  const settle = async () => { for (let i = 0; i < 4; i++) await delay(0); };
  const click = async (label, scope = document) => { const button = [...scope.querySelectorAll("button")].find(b => b.textContent.trim() === label); if (!button) throw new Error(`Missing button ${label}`); expect(button.disabled).toBe(false); button.click(); await settle(); return button; };
  const module = id => document.querySelector(`.platform-module-card[data-module-id="${id}"]`);
  const toggle = async id => { expect(module(id)).not.toBeNull(); module(id).click(); await settle(); };
  const aria = async (label, scope = document) => { const button = scope.querySelector(`button[aria-label="${label}"]`); if (!button) throw new Error(`Missing action ${label}`); expect(button.disabled).toBe(false); button.click(); await settle(); };
  const selected = () => [...document.querySelectorAll(".platform-assembly-item")].map(item => item.dataset.moduleId);
  const input = (label, value) => { const field = document.querySelector(`[aria-label="${label}"]`); if (!field) throw new Error(`Missing input ${label}`); field.value = value; field.dispatchEvent(new window.Event("input")); };
  const submit = async () => { document.querySelector("dialog form").dispatchEvent(new window.Event("submit", { cancelable: true })); await settle(); };
  return { document, window, api, ui, settle, click, module, toggle, aria, selected, input, submit, onReady };
}

describe("research platform module assembly", () => {
  it("places a custom-module plus after the builtins and removes duplicate building methods", async () => {
    const f = await fixture();
    expect(f.document.querySelector(".platform-module-grid").lastElementChild.id).toBe("platform-custom-module");
    expect(f.document.querySelector("#platform-custom-module").textContent).toContain("+");
    expect(f.document.querySelector(".platform-page").textContent).not.toContain("更多搭建方式");
    expect(f.document.querySelector(".platform-start-grid")).toBeNull();
    f.input("搜索科研模块", "没有匹配的模块");
    expect(f.document.querySelector("#platform-custom-module")).not.toBeNull();
  });

  it("manually saves a reusable custom module into the existing assembly before creating a platform", async () => {
    const f = await fixture(); await f.toggle("samples");
    f.input("平台名称", "仪器平台");
    await f.aria("添加自定义模块"); await f.click("自己设计");
    f.input("模块名称", "设备校准"); f.input("模块用途", "记录设备编号与校准信息");
    f.input("字段名称", "设备编号");
    await f.click("使用预览");
    expect(f.document.querySelector(".platform-record-form [aria-label^='设备编号']").disabled).toBe(true);
    expect(f.api.platformModuleSave).not.toHaveBeenCalled();
    await f.click("保存模块并加入组合");
    expect(f.api.platformModuleSave).toHaveBeenCalledTimes(1);
    const customId = f.selected()[1];
    expect(customId).toMatch(/^custom_/);
    expect(f.selected()).toEqual(["samples", customId]);
    expect(f.document.querySelector("[aria-label='平台名称']").value).toBe("仪器平台");
    expect(f.module(customId).querySelector("strong").textContent).toBe("设备校准");
    expect(f.api.platformCreate).not.toHaveBeenCalled();
    await f.click("保存并进入对话"); await f.submit();
    const platform = f.api.platformCreate.mock.calls[0][0];
    expect(platform.name).toBe("仪器平台");
    expect(platform.modules).toEqual(["samples", customId]);
    expect(platform.customModules[0].pages[0].fields[0].label).toBe("设备编号");
    expect(() => validateDefinition(platform)).not.toThrow();
    expect(f.ui.isOpen()).toBe(false);
    expect(f.onReady).toHaveBeenCalledExactlyOnceWith((await f.api.platformCreate.mock.results[0].value).snapshot);
  });

  it("shows editable AI output and saves only after the user checks it", async () => {
    const module = validateResearchModule({ title: "AI 校准模块", pages: [{ id: "data", title: "校准记录", kind: "records", fields: [{ id: "device", label: "设备", type: "text" }] }], capabilities: ["records"] });
    const f = await fixture(emptyState(), { platformModuleGenerate: vi.fn(async () => ({ module, explanation: "生成了校准记录表。" })) });
    await f.aria("添加自定义模块"); f.input("描述模块需求", "记录设备校准"); await f.submit();
    expect(f.api.platformModuleGenerate).toHaveBeenCalledExactlyOnceWith({ requirement: "记录设备校准" });
    expect(f.document.querySelector('[aria-label="模块名称"]').value).toBe("AI 校准模块");
    expect(f.document.querySelector('[aria-label="积木颜色"]').value).toBe(module.color);
    expect(f.api.platformModuleSave).not.toHaveBeenCalled();
    expect(f.api.platformCreate).not.toHaveBeenCalled();
    f.input("模块名称", "我的校准表"); f.input("字段名称", "仪器编号");
    await f.click("保存模块并加入组合");
    const saved = f.api.platformModuleSave.mock.calls[0][0];
    expect(saved.id).toBe(module.id);
    expect(saved.pages[0].id).toBe(module.pages[0].id);
    expect(saved.pages[0].fields[0].label).toBe("仪器编号");
    expect(f.selected()).toEqual([module.id]);
    expect(f.module(module.id).querySelector("strong").textContent).toBe("我的校准表");
  });

  it("keeps the assembly intact when custom design is cancelled or AI generation fails", async () => {
    const f = await fixture(); await f.toggle("datasets"); f.input("平台名称", "已有组合");
    await f.aria("添加自定义模块"); await f.click("自己设计"); f.input("模块名称", "不保存的模块");
    await f.click("返回模块组合");
    expect(f.selected()).toEqual(["datasets"]);
    expect(f.document.querySelector('[aria-label="平台名称"]').value).toBe("已有组合");
    expect(f.api.platformModuleSave).not.toHaveBeenCalled();
    await f.aria("添加自定义模块"); f.input("描述模块需求", "请帮我设计"); await f.submit();
    expect(f.document.querySelector(".platform-dialog-error").textContent).toContain("配置模型");
    expect(f.document.querySelector("dialog").open).toBe(true);
    expect(f.selected()).toEqual(["datasets"]);
    expect(f.api.platformModuleSave).not.toHaveBeenCalled();
  });

  it("opens all eleven named module buttons with an empty assembly and disabled save", async () => {
    const f = await fixture();
    expect([...f.document.querySelectorAll(".platform-module-card")].map(b => b.dataset.moduleId)).toEqual(ids);
    expect([...f.document.querySelectorAll(".platform-module-card strong")].map(n => n.textContent)).toEqual(titles);
    for (const [index, id] of ids.entries()) {
      expect(f.module(id).tagName).toBe("BUTTON");
      expect(f.module(id).getAttribute("aria-pressed")).toBe("false");
      expect(f.module(id).getAttribute("aria-label")).toBe(`添加${titles[index]}`);
    }
    expect(f.selected()).toEqual([]);
    expect(f.document.querySelector(".platform-assembly-block")).toBeNull();
    expect([...f.document.querySelectorAll("button")].find(b => b.textContent === "保存并进入对话").disabled).toBe(true);
    expect(f.document.querySelector(".app-shell").inert).toBe(true);
  });

  it("adds one visible brick per selection, removes from either representation, and clears", async () => {
    const f = await fixture();
    for (const id of ids) await f.toggle(id);
    expect(f.selected()).toEqual(ids);
    expect(f.document.querySelectorAll(".platform-assembly-block")).toHaveLength(11);
    expect(f.document.querySelectorAll('.platform-module-card[aria-pressed="true"]')).toHaveLength(11);
    f.document.querySelector('.platform-assembly-block[data-module-id="datasets"]').dispatchEvent(new f.window.Event("click")); await f.settle();
    expect(f.selected()).toEqual(ids.slice(1));
    expect(f.module("datasets").getAttribute("aria-pressed")).toBe("false");
    await f.aria("移除综合写作", f.document.querySelector('.platform-assembly-item[data-module-id="writing"]'));
    expect(f.selected()).toEqual(ids.slice(1, -1));
    await f.click("清空积木");
    expect(f.selected()).toEqual([]);
    expect(f.document.querySelectorAll(".platform-assembly-block")).toHaveLength(0);
    expect(f.api.platformCreate).not.toHaveBeenCalled();
  });

  it("persists chosen order, real generated pages and capabilities only after review", async () => {
    const f = await fixture();
    f.input("平台名称", "我的模块实验室");
    for (const id of ["datasets", "analysis", "writing"]) await f.toggle(id);
    expect(f.document.querySelector('button[aria-label="上移数据集管理"]').disabled).toBe(true);
    expect(f.document.querySelector('button[aria-label="下移综合写作"]').disabled).toBe(true);
    await f.aria("上移综合写作");
    expect(f.selected()).toEqual(["datasets", "writing", "analysis"]);
    await f.aria("下移数据集管理");
    expect(f.selected()).toEqual(["writing", "datasets", "analysis"]);
    await f.click("保存并进入对话");
    expect(f.document.querySelector("dialog").open).toBe(true);
    expect(f.document.querySelector('dialog button[type="submit"]').textContent).toBe("保存并进入对话");
    expect(f.api.platformCreate).not.toHaveBeenCalled();
    expect(f.onReady).not.toHaveBeenCalled();
    await f.submit();
    expect(f.api.platformCreate).toHaveBeenCalledTimes(1);
    const saved = f.api.platformCreate.mock.calls[0][0];
    expect(saved.name).toBe("我的模块实验室");
    expect(saved.modules).toEqual(["writing", "datasets", "analysis"]);
    expect([...new Set(saved.pages.map(p => p.moduleId))]).toEqual(saved.modules);
    expect(saved.pages.every(p => saved.modules.includes(p.moduleId))).toBe(true);
    expect(saved.capabilities).toEqual(expect.arrayContaining(["records", "files", "statistics", "charts", "notes"]));
    expect(new Set(saved.pages.map(p => p.id)).size).toBe(saved.pages.length);
    expect(f.document.querySelector(".platform-panel").hidden).toBe(true);
    expect(f.document.querySelector(".app-shell").inert).toBe(false);
    expect(f.onReady).toHaveBeenCalledExactlyOnceWith((await f.api.platformCreate.mock.results[0].value).snapshot);
    await f.ui.open();
    expect(f.document.querySelectorAll(".platform-module-summary-card")).toHaveLength(3);
  });

  it("supports data analysis by itself with its own valid source records", async () => {
    const f = await fixture(); await f.toggle("analysis"); await f.click("保存并进入对话"); await f.submit();
    const saved = f.api.platformCreate.mock.calls[0][0], analysis = saved.pages.find(p => p.kind === "analysis"), source = saved.pages.find(p => p.id === analysis.sourcePageId);
    expect(saved.modules).toEqual(["analysis"]);
    expect(saved.pages.every(p => p.moduleId === "analysis")).toBe(true);
    expect(source.kind).toBe("records");
    expect(source.fields.find(field => field.id === analysis.valueField).type).toBe("number");
    expect(() => validateDefinition(saved)).not.toThrow();
    expect(f.ui.isOpen()).toBe(false);
    await f.ui.open();
    await f.click("继续搭建"); expect(f.selected()).toEqual(["analysis"]);
  });

  it("restores edited fields on deselect/reselect and never duplicates pages", async () => {
    const definition = composeModuleDefinition(base(), ["samples", "analysis"]);
    const samples = definition.pages.find(p => p.moduleId === "samples");
    samples.title = "自己的样本台账";
    samples.fields[0].label = "自定义样本标识";
    samples.fields.push({ id: "custom_extra", label: "自定义字段", type: "text" });
    const f = await fixture(savedState(definition)); await f.click("继续搭建");
    await f.toggle("samples"); await f.toggle("samples"); await f.toggle("samples"); await f.toggle("samples");
    await f.click("保存变更并进入对话"); await f.submit();
    const { definition: revised, expectedVersion } = f.api.platformRevise.mock.calls[0][0];
    expect(expectedVersion).toBe(2);
    expect(revised.pages.filter(p => p.moduleId === "samples")).toEqual([samples]);
    expect(revised.modules).toEqual(["analysis", "samples"]);
    expect(new Set(revised.pages.map(p => p.id)).size).toBe(revised.pages.length);
    expect(f.api.platformRecord).not.toHaveBeenCalled();
    expect(f.ui.isOpen()).toBe(false);
    expect(f.onReady).toHaveBeenCalledExactlyOnceWith((await f.api.platformRevise.mock.results[0].value).snapshot);
  });

  it("revises selection without writing or modifying existing scientific records", async () => {
    const definition = composeModuleDefinition(base(), ["samples", "analysis"]), state = savedState(definition);
    const page = definition.pages.find(p => p.moduleId === "samples"), field = page.fields[0];
    state.snapshot.records = [{ id: "r1", pageId: page.id, values: { [field.id]: "真实样本" }, source: "user" }];
    const before = copy(state.snapshot.records);
    const f = await fixture(state); await f.click("继续搭建"); await f.toggle("samples"); await f.click("保存变更并进入对话");
    expect(f.document.querySelector("dialog").textContent).toContain("移除页面");
    await f.submit();
    expect(f.api.platformRevise.mock.calls[0][0].definition.modules).toEqual(["analysis"]);
    expect(f.api.platformRecord).not.toHaveBeenCalled();
    expect(state.snapshot.records).toEqual(before);
  });

  it("filters module choices without losing selected bricks", async () => {
    const f = await fixture(); await f.toggle("datasets");
    f.input("搜索科研模块", "文献筛选");
    expect([...f.document.querySelectorAll(".platform-module-card")].map(b => b.dataset.moduleId)).toEqual(["screening"]);
    await f.toggle("screening");
    expect(f.selected()).toEqual(["datasets", "screening"]);
    f.input("搜索科研模块", "没有这样的模块");
    expect(f.document.querySelectorAll(".platform-module-card")).toHaveLength(0);
    expect(f.selected()).toEqual(["datasets", "screening"]);
    f.input("搜索科研模块", "");
    expect(f.document.querySelectorAll(".platform-module-card")).toHaveLength(11);
    expect(f.module("datasets").getAttribute("aria-pressed")).toBe("true");
  });

  it("makes preview bricks keyboard-operable with announced labels and count", async () => {
    const f = await fixture(); await f.toggle("datasets"); await f.toggle("analysis");
    const block = f.document.querySelector('.platform-assembly-block[data-module-id="analysis"]');
    expect(block.getAttribute("role")).toBe("button");
    expect(block.getAttribute("tabindex")).toBe("0");
    expect(block.getAttribute("aria-label")).toBe("移除数据分析");
    const event = new f.window.Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value: " " });
    block.dispatchEvent(event); await f.settle();
    expect(event.defaultPrevented).toBe(true);
    expect(f.selected()).toEqual(["datasets"]);
    expect(f.document.querySelector(".platform-assembly-header [aria-live='polite']").textContent).toBe("1 / 11");
    expect(f.module("analysis").dataset.focused).toBe("true");
  });
});
