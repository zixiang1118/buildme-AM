import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PlatformStore, validateDefinition } from "../desktop/platform-store.mjs";

const definition = () => ({ schemaVersion: 1, name: "我的实验平台", description: "由用户搭建的记录与分析", capabilities: ["records", "files", "statistics", "charts", "notes"],
  pages: [{ id: "samples", title: "样品记录", kind: "records", fields: [
    { id: "sample", label: "样品编号", type: "text", required: true }, { id: "group", label: "条件", type: "text" },
    { id: "value", label: "响应", type: "number", unit: "mg/L" }, { id: "memo", label: "备注", type: "longtext" },
  ] }, { id: "analysis", title: "比较结果", kind: "analysis", sourcePageId: "samples", valueField: "value", groupField: "group", sampleField: "sample" },
  { id: "notes", title: "研究记录", kind: "notes" }], assistant: { role: "研究助手", instructions: "按来源复核" }, workflows: [{ id: "compare", title: "数据比较", steps: ["import", "analyze", "report"] }] });

async function workspace(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "buildme-platform-test-"));
  const actual = path.resolve(root), intended = path.resolve(os.tmpdir());
  if (path.dirname(actual) !== intended || !path.basename(actual).startsWith("buildme-platform-test-")) throw new Error("拒绝清理测试目录之外的位置");
  try { return await operation(root); }
  finally {
    await fs.rm(actual, { recursive: true, force: true });
  }
}

describe("user-built platform store", () => {
  it("starts without creating a workspace folder, creates a generic definition and persists notes", async () => workspace(async (root) => {
    const store = new PlatformStore(root);
    expect(await store.list()).toEqual([]);
    await expect(fs.stat(path.join(root, ".buildme"))).rejects.toMatchObject({ code: "ENOENT" });
    const created = await store.create(definition());
    expect(created.definitionVersion).toBe(1);
    expect(created.definition.pages[2].fields.map((field) => field.id)).toEqual(["title", "body"]);
    await store.record(created.definition.id, "notes", { values: { title: "观察", body: "先检查仪器漂移" } });
    const restored = await new PlatformStore(root).get(created.definition.id);
    expect(restored.records[0]).toMatchObject({ pageId: "notes", values: { title: "观察", body: "先检查仪器漂移" }, source: "user" });
    expect((await store.list())[0]).toMatchObject({ name: "我的实验平台", pageCount: 3, recordCount: 1 });
  }));

  it("removes a platform from the catalog while retaining records and attached files in workspace trash", async () => workspace(async (root) => {
    const store = new PlatformStore(root), created = await store.create(definition()), key = created.definition.id;
    const retained = await store.create({ ...definition(), name: "继续保留的平台" });
    const sourcePath = path.join(root, "source.csv"), original = "sample,value\na,7\n";
    await fs.writeFile(sourcePath, original);
    const { asset } = await store.registerAsset(key, { sourcePath, pageId: "samples" });
    await store.importRows(key, "samples", { rows: [{ sample: "a", value: 7 }], assetIds: [asset.id] });
    const removed = await store.remove(key);
    expect(removed.id).toBe(key);
    expect(path.dirname(removed.archivePath)).toBe(path.join(root, ".buildme", "platforms", ".trash"));
    expect((await new PlatformStore(root).list()).map((entry) => entry.id)).toEqual([retained.definition.id]);
    await expect(store.get(key)).rejects.toMatchObject({ code: "ENOENT" });
    const archived = JSON.parse(await fs.readFile(path.join(removed.archivePath, "snapshot.json"), "utf8"));
    expect(archived.records[0].values).toMatchObject({ sample: "a", value: 7 });
    expect(archived.history).toHaveLength(1);
    expect(await fs.readFile(path.join(removed.archivePath, asset.relativePath), "utf8")).toBe(original);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
    await expect(fs.stat(path.join(removed.archivePath, ".write.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.remove("../source.csv")).rejects.toThrow("编号无效");
  }));

  it("waits for platform writes before archiving their completed data", async () => workspace(async (root) => {
    const store = new PlatformStore(root), created = await store.create(definition()), key = created.definition.id;
    let entered, release;
    const writing = new Promise((resolve) => { entered = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    const save = store._write.bind(store);
    store._write = async (...args) => { entered(); await resume; return save(...args); };
    const pendingWrite = store.record(key, "samples", { values: { sample: "last", value: 13 } });
    await writing;
    const pendingRemoval = new PlatformStore(root).remove(key);
    release();
    await pendingWrite;
    const removed = await pendingRemoval;
    expect(JSON.parse(await fs.readFile(path.join(removed.archivePath, "snapshot.json"), "utf8")).records[0].values.value).toBe(13);
    expect(await store.list()).toEqual([]);
  }));

  it("rejects a workspace trash junction that points outside the platform root", async () => workspace(async (root) => {
    const store = new PlatformStore(root), created = await store.create(definition()), key = created.definition.id;
    const outside = path.join(root, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, ".buildme", "platforms", ".trash"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.remove(key)).rejects.toThrow("平台边界");
    expect((await store.get(key)).definition.id).toBe(key);
    expect(await fs.readdir(outside)).toEqual([]);
  }));

  it("validates unique identifiers, forbidden keys, references and field data", async () => workspace(async (root) => {
    const duplicate = definition(); duplicate.pages[0].fields.push({ id: "value", label: "重复", type: "number" });
    expect(() => validateDefinition(duplicate)).toThrow("不能重复");
    const reserved = definition(); reserved.pages[0].fields[0].id = "constructor";
    expect(() => validateDefinition(reserved)).toThrow("编号无效");
    const badReference = definition(); badReference.pages[1].valueField = "absent";
    expect(() => validateDefinition(badReference)).toThrow("字段不存在");
    const store = new PlatformStore(root), created = await store.create(definition()), key = created.definition.id;
    await expect(store.record(key, "samples", { values: { value: 1 } })).rejects.toThrow("必填");
    await expect(store.record(key, "samples", { values: { sample: "s", value: Infinity } })).rejects.toThrow("有限数值");
    await expect(store.record(key, "samples", { values: JSON.parse('{"sample":"s","__proto__":"bad"}') })).rejects.toThrow("编号无效");
    expect((await store.get(key)).records).toEqual([]);
  }));

  it("preserves data across removed pages and fields and restores configuration as a new version", async () => workspace(async (root) => {
    const store = new PlatformStore(root), created = await store.create(definition()), key = created.definition.id;
    await store.record(key, "samples", { values: { sample: "s", value: 42, memo: "保留" } });
    const next = definition(); next.name = "简化版"; next.pages = [{ ...next.pages[0], fields: next.pages[0].fields.filter((field) => field.id !== "memo") }];
    const revised = await store.revise(key, next, { expectedVersion: 1 });
    expect(revised.definitionVersion).toBe(2);
    expect(revised.records[0].values.memo).toBe("保留");
    expect(revised.archivedPages.map((page) => page.id)).toContain("notes");
    expect(revised.archivedFields).toContainEqual(expect.objectContaining({ pageId: "samples", id: "memo" }));
    const edited = await store.record(key, "samples", { id: revised.records[0].id, values: { ...revised.records[0].values, value: 43 } });
    expect(edited.records[0].values).toMatchObject({ memo: "保留", value: 43 });
    await expect(store.record(key, "samples", { id: revised.records[0].id, values: { memo: "修改归档" } })).rejects.toThrow("当前页面配置");
    const returned = await store.restore(key, 1);
    expect(returned.definitionVersion).toBe(3);
    expect(returned.history.map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(returned.history[2].restoredFrom).toBe(1);
    expect(returned.definition.name).toBe("我的实验平台");
    expect(returned.records[0].values.memo).toBe("保留");
  }));

  it("checks expected versions within the write lock and keeps concurrent records", async () => workspace(async (root) => {
    const first = new PlatformStore(root), second = new PlatformStore(root), created = await first.create(definition()), key = created.definition.id;
    const outcomes = await Promise.allSettled([first.revise(key, { ...definition(), name: "甲" }, { expectedVersion: 1 }), second.revise(key, { ...definition(), name: "乙" }, { expectedVersion: 1 })]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).record(key, "samples", { values: { sample: `s${index}`, value: index } })));
    const result = await second.get(key);
    expect(result.definitionVersion).toBe(2);
    expect(result.history).toHaveLength(2);
    expect(new Set(result.records.map((record) => record.values.sample)).size).toBe(20);
    const moduleUrl = pathToFileURL(path.resolve("desktop/platform-store.mjs")).href;
    const writer = (prefix) => new Promise((resolve, reject) => {
      const program = `import {PlatformStore} from ${JSON.stringify(moduleUrl)}; const store=new PlatformStore(${JSON.stringify(root)}); for(let i=0;i<4;i++)await store.record(${JSON.stringify(key)},"samples",{values:{sample:${JSON.stringify(prefix)}+i,value:i}});`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let diagnostics = ""; child.stderr.on("data", (data) => { diagnostics += data.toString(); });
      child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(diagnostics || `child exited ${code}`)));
    });
    await Promise.all([writer("process-a-"), writer("process-b-")]);
    expect((await first.get(key)).records).toHaveLength(28);
  }));

  it("averages technical readings, preserves missing data, tags examples and freezes run evidence", async () => workspace(async (root) => {
    const store = new PlatformStore(root), created = await store.create(definition()), key = created.definition.id;
    await store.importRows(key, "samples", { source: "example", filename: "demo.csv", rows: [
      { sample: "a", group: "A", value: 10 }, { sample: "a", group: "A", value: 14 }, { sample: "b", group: "A", value: 20 },
      { sample: "c", group: "A", value: null }, { sample: "x", group: "B", value: 0 },
    ] });
    const { run } = await store.analyze(key, { pageId: "samples", valueField: "value", groupField: "group", sampleField: "sample" });
    expect(run.result.rows[0]).toMatchObject({ group: "A", n: 2, readings: 3, mean: 16, sd: Math.sqrt(32) });
    expect(run.result.rows[1]).toMatchObject({ group: "B", n: 1, readings: 1, mean: 0, sd: null });
    expect(run.result.missing).toBe(1);
    expect(run.result.points).toHaveLength(4);
    expect(run.result.warnings.join(" ")).toContain("示例数据");
    expect(run.result.warnings.join(" ")).toContain("没有补成零");
    const row = run.inputs[0];
    await store.record(key, "samples", { id: row.id, values: { value: 99 } });
    const saved = (await store.get(key)).runs[0];
    expect(saved.inputs[0].values.value).toBe(10);
    expect(saved.inputHashes[0].sha256).toBe(createHash("sha256").update(JSON.stringify(row)).digest("hex"));
    expect(saved.definitionVersion).toBe(1);
  }));

  it("imports atomically and disables analysis while keeping basic records available", async () => workspace(async (root) => {
    const store = new PlatformStore(root), created = await store.create({ ...definition(), capabilities: [] }), key = created.definition.id;
    await store.record(key, "samples", { values: { sample: "a", value: 1 } });
    await expect(store.importRows(key, "samples", { rows: [{ sample: "b", value: 2 }, { sample: "c", value: "wrong" }] })).rejects.toThrow("有限数值");
    expect((await store.get(key)).records).toHaveLength(1);
    await expect(store.analyze(key, { pageId: "samples", valueField: "value" })).rejects.toThrow("启用统计");
    expect((await store.get(key)).runs).toEqual([]);
  }));

  it("links imported rows to immutable copied files and exports portable verified evidence", async () => workspace(async (root) => {
    const store = new PlatformStore(root), created = await store.create(definition()), key = created.definition.id;
    const sourcePath = path.join(root, "original.csv");
    await fs.writeFile(sourcePath, "sample,value\na,8\n");
    const { asset } = await store.registerAsset(key, { sourcePath, pageId: "samples" });
    const expectedHash = createHash("sha256").update("sample,value\na,8\n").digest("hex");
    expect(asset.sha256).toBe(expectedHash);
    await fs.writeFile(sourcePath, "changed\n");
    await store.importRows(key, "samples", { rows: [{ sample: "a", value: 8 }], filename: "original.csv", assetIds: [asset.id] });
    const { run } = await store.analyze(key, { pageId: "samples", valueField: "value", sampleField: "sample" });
    expect(run.assetIds).toEqual([asset.id]);
    const exported = await store.exportPlatform(key, root);
    const exportedAsset = await fs.readFile(path.join(exported, asset.relativePath), "utf8");
    expect(exportedAsset).toBe("sample,value\na,8\n");
    expect(JSON.parse(await fs.readFile(path.join(exported, "definition.json"), "utf8")).records).toBeUndefined();
    const restored = await new PlatformStore(root).get(key);
    expect(restored.records[0].assetIds).toEqual([asset.id]);
    const location = await store.assetLocation(key, asset.id);
    await fs.writeFile(location.path, "tampered");
    await expect(store.assetLocation(key, asset.id)).rejects.toThrow("校验失败");
    await expect(store.exportPlatform(key, root)).rejects.toThrow("校验失败");
  }));

  it("rejects cross-platform asset links and path traversal identifiers", async () => workspace(async (root) => {
    const store = new PlatformStore(root), one = await store.create(definition()), two = await store.create(definition());
    const sourcePath = path.join(root, "source.txt"); await fs.writeFile(sourcePath, "evidence");
    const { asset } = await store.registerAsset(one.definition.id, { sourcePath });
    await expect(store.importRows(two.definition.id, "samples", { rows: [{ sample: "a", value: 8 }], assetIds: [asset.id] })).rejects.toThrow("文件证据不存在");
    await expect(store.get("../outside")).rejects.toThrow("编号无效");
    await expect(store.record(two.definition.id, "samples", { id: asset.id, values: { sample: "a" } })).rejects.toThrow("记录不存在");
    expect((await store.get(two.definition.id)).records).toHaveLength(0);
  }));

  it("binds configurable workflows and reports to preserved analysis evidence", async () => workspace(async (root) => {
    const customized = definition();
    Object.assign(customized.workflows[0], { sourcePageId: "samples", valueField: "value", groupField: "group", sampleField: "sample" });
    const store = new PlatformStore(root), created = await store.create(customized), key = created.definition.id;
    expect(created.definition.workflows[0].sourcePageId).toBe("samples");
    await store.record(key, "samples", { values: { sample: "a", value: 10 } });
    const analysis = await store.analyze(key, { pageId: "samples", valueField: "value", sampleField: "sample" });
    await store.record(key, "samples", { id: analysis.run.inputs[0].id, values: { value: 100 } });
    const { run } = await store.report(key, { runId: analysis.run.id });
    expect(run.kind).toBe("report");
    expect(run.sourceRunIds).toEqual([analysis.run.id]);
    expect(run.result.body).toContain("均值 10");
    expect(run.result.body).not.toContain("均值 100");
    expect(run.inputHashes[0].sha256).toBe(createHash("sha256").update(JSON.stringify(analysis.run)).digest("hex"));
    const completed = await store.addRun(key, { kind: "workflow", workflowId: "compare", status: "completed", stepResults: [{ step: "analyze", runId: analysis.run.id }, { step: "report", runId: run.id }] });
    expect(completed.run.workflow.sourcePageId).toBe("samples");
    expect(completed.run.definitionVersion).toBe(1);
    await expect(store.addRun(key, { kind: "workflow", workflowId: "missing", status: "completed" })).rejects.toThrow("流程不存在");
    await expect(store.report(key, { runId: completed.run.id })).rejects.toThrow("请先执行分析");
  }));

  it("refuses workspace junction escapes before creating or reading outside directories", async () => workspace(async (root) => {
    const outside = path.join(root, "outside"), workspaceRoot = path.join(root, "workspace");
    await fs.mkdir(outside); await fs.mkdir(workspaceRoot);
    await fs.symlink(outside, path.join(workspaceRoot, ".buildme"), process.platform === "win32" ? "junction" : "dir");
    const store = new PlatformStore(workspaceRoot);
    await expect(store.list()).rejects.toThrow("工作区边界");
    await expect(store.create(definition())).rejects.toThrow("工作区边界");
    expect(await fs.readdir(outside)).toEqual([]);
  }));
});
