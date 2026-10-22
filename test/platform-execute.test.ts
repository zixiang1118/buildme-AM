import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { platformExecuteTool } from "../src/core/platform-tools.js";

const roots: string[] = [];
const storeUrl = new URL("../desktop/platform-store.mjs", import.meta.url).href;
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "platform-execute-")); roots.push(workspace);
  const { PlatformStore } = await import(storeUrl), store = new PlatformStore(workspace);
  const snapshot = await store.create({ name: "我的积木", capabilities: ["records", "files", "statistics"], pages: [
    { id: "data", title: "自定义数据", kind: "records", fields: [{ id: "sample", label: "样品", type: "text", required: true }, { id: "value", label: "数值", type: "number" }] },
    { id: "summary", title: "我的统计", kind: "analysis", sourcePageId: "data", valueField: "value", sampleField: "sample" },
  ], workflows: [{ id: "all", title: "完整流程", steps: ["import", "analyze", "report"], sourcePageId: "data", valueField: "value", sampleField: "sample" },
    { id: "bad", title: "缺分析流程", steps: ["import", "report"], sourcePageId: "data", valueField: "value" }] });
  const base = { platformId: snapshot.definition.id as string, expectedVersion: 1 };
  const execute = (args: Record<string, unknown>, signal?: AbortSignal) => platformExecuteTool(workspace, { ...base, ...args } as Parameters<typeof platformExecuteTool>[1], signal) as Promise<any>;
  return { workspace, store, base, execute };
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { const target = resolve(root); expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^platform-execute-/); await rm(target, { recursive: true, force: true }); } });

describe("saved research blocks execute in chat", () => {
  it("imports original workspace data, computes independent sample means and creates a sourced report", async () => {
    const f = await fixture(); await writeFile(join(f.workspace, "table.csv"), "sample,value\na,10\na,14\nb,20\nc,30\n");
    const result = await f.execute({ action: "workflow", workflowId: "all", sourcePath: "table.csv" });
    expect(result.run).toMatchObject({ status: "completed", kind: "workflow", definitionVersion: 1 });
    expect(result.stepResults.map((step: any) => step.step)).toEqual(["import", "analyze", "report"]);
    const saved = await f.store.get(f.base.platformId), analysis = saved.runs.find((run: any) => run.kind === "descriptive-statistics");
    expect(saved.records).toHaveLength(4); expect(saved.assets).toHaveLength(1);
    expect(analysis.result.rows[0]).toMatchObject({ n: 3, readings: 4, mean: 62 / 3 });
    expect(analysis.inputs[0].assetIds).toEqual([saved.assets[0].id]);
    expect(saved.runs.find((run: any) => run.kind === "report").sourceRunIds).toEqual([analysis.id]);
    expect(saved.runs.find((run: any) => run.kind === "report").result.body).toContain("重复读数先在样品内平均");
  });
  it("saves and updates actual records, and uses the chosen analysis block's configured fields", async () => {
    const f = await fixture(), first = await f.execute({ action: "record", pageId: "data", source: "example", values: { sample: "s1", value: 3 } });
    await f.execute({ action: "record", pageId: "data", recordId: first.record.id, values: { value: 9 } });
    const result = await f.execute({ action: "analyze", pageId: "summary" });
    expect(result.run.config).toEqual({ pageId: "data", valueField: "value", sampleField: "sample" });
    expect(result.run.result.rows[0]).toMatchObject({ n: 1, mean: 9, sd: null });
    expect(result.run.sources).toEqual(["example"]); expect(result.run.warnings.join(" ")).toContain("示例数据");
    await expect(f.execute({ action: "record", pageId: "data", values: { sample: "s2", invented: 2 } })).rejects.toThrow("不在当前页面");
    expect((await f.store.get(f.base.platformId)).records).toHaveLength(1);
    expect((await f.execute({ action: "report", runId: result.run.id })).run.sourceRunIds).toEqual([result.run.id]);
  });
  it("refuses stale definitions and outside/junction source paths before importing", async () => {
    const f = await fixture(), outside = await fixture(); await writeFile(join(outside.workspace, "table.csv"), "sample,value\na,10\n");
    await expect(f.execute({ action: "import", pageId: "data", sourcePath: join(outside.workspace, "table.csv") })).rejects.toThrow("工作区");
    await symlink(outside.workspace, join(f.workspace, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(f.execute({ action: "import", pageId: "data", sourcePath: "alias/table.csv" })).rejects.toThrow("边界");
    const current = await f.store.get(f.base.platformId); await f.store.revise(f.base.platformId, current.definition, { expectedVersion: 1 });
    await expect(f.execute({ action: "record", pageId: "data", values: { sample: "s", value: 2 } })).rejects.toThrow("已改变");
    expect((await f.store.get(f.base.platformId)).records).toEqual([]); expect((await f.store.get(f.base.platformId)).assets).toEqual([]);
  });
  it("retains completed imports and honest failure evidence when a saved workflow lacks analysis", async () => {
    const f = await fixture(); await writeFile(join(f.workspace, "table.csv"), "sample,value\na,10\n");
    await expect(f.execute({ action: "workflow", workflowId: "bad", sourcePath: "table.csv" })).rejects.toThrow("尚未分析");
    const saved = await f.store.get(f.base.platformId);
    expect(saved.records).toHaveLength(1); expect(saved.runs).toEqual([expect.objectContaining({ kind: "workflow", status: "failed", stepResults: [expect.objectContaining({ step: "import", records: 1 })] })]);
  });
  it("cancels queued operations without a later write", async () => {
    const f = await fixture(); let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(done => { started = done; }), gate = new Promise<void>(done => { release = done; });
    const held = f.store.execute(f.base.platformId, { expectedVersion: 1 }, async () => { started(); await gate; });
    await ready;
    const controller = new AbortController(), pending = f.execute({ action: "record", pageId: "data", values: { sample: "never", value: 100 } }, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    controller.abort(); release(); await held;
    await rejected;
    expect((await f.store.get(f.base.platformId)).records).toEqual([]);
  });
  it("checks the definition version after a concurrent desktop revision releases its write lock", async () => {
    const f = await fixture(); let release!: () => void, started!: () => void, queued!: () => void;
    const ready = new Promise<void>(done => { started = done; }), gate = new Promise<void>(done => { release = done; }), revisionQueued = new Promise<void>(done => { queued = done; });
    const held = f.store.execute(f.base.platformId, { expectedVersion: 1 }, async () => { started(); await gate; }); await ready;
    const original = f.store._locked.bind(f.store);
    f.store._locked = (...args: any[]) => { const pending = original(...args); queued(); return pending; };
    const snapshot = await f.store.get(f.base.platformId), revision = f.store.revise(f.base.platformId, { ...snapshot.definition, name: "已修改" }, { expectedVersion: 1 });
    await revisionQueued;
    const pending = f.execute({ action: "record", pageId: "data", values: { sample: "stale", value: 3 } }), rejected = expect(pending).rejects.toThrow("已改变");
    release(); await held; await revision; await rejected;
    expect((await f.store.get(f.base.platformId)).records).toEqual([]);
  });
  it("persists a cancelled workflow with completed import evidence and never runs later analysis", async () => {
    const f = await fixture(), controller = new AbortController(), module = await import(storeUrl);
    await writeFile(join(f.workspace, "table.csv"), "sample,value\na,10\n");
    const original = module.PlatformStore.prototype.importRows;
    vi.spyOn(module.PlatformStore.prototype, "importRows").mockImplementation(async function(this: any, ...args: any[]) {
      const result = await original.apply(this, args); controller.abort(); return result;
    });
    await expect(f.execute({ action: "workflow", workflowId: "all", sourcePath: "table.csv" }, controller.signal)).rejects.toThrow("已保留");
    const saved = await f.store.get(f.base.platformId);
    expect(saved.records).toHaveLength(1); expect(saved.runs).toEqual([expect.objectContaining({ kind: "workflow", status: "cancelled", stepResults: [expect.objectContaining({ step: "import" })] })]);
  });
});
