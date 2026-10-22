import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { setInterval, clearInterval } from "node:timers";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { ResearchService } from "../desktop/research-service.mjs";
import { readAssayFile } from "../desktop/research-import.mjs";

class LocalService extends ResearchService { async chemistryStatus() { return { ready: false }; } }
async function fixture() {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "buildme-research-service-")), workspace = join(root, "workspace");
  await mkdir(workspace); await mkdir(join(root, "user-data"));
  const service = new LocalService({ appRoot: resolve("."), userData: join(root, "user-data"), getWorkspace: async () => workspace });
  await service.createProject({ title: "软件示例研究", objective: "测试来源追溯", target: "示例体系" });
  await service.mutate({ action: "addCompound", data: { name: "测试结构", smiles: "CCO", provenance: "example" } });
  return { root, workspace, service, cleanup: async () => { expect(dirname(resolve(root))).toBe(parent); expect(basename(root)).toMatch(/^buildme-research-service-/); await rm(root, { recursive: true, force: true }); } };
}
describe("research desktop service", () => {
  it("links parsed CSV readings to the exact archived source and preserves portable export", async () => {
    const f = await fixture();
    try {
      let state = await f.service.state();
      await f.service.mutate({ action: "recordBatch", data: { compoundId: state.snapshot.compounds[0].id, code: "示例批次", provenance: "example" } });
      state = await f.service.state();
      const path = join(f.root, "readings.csv");
      await writeFile(path, "sampleId,value,group\ns1,0,A\ns1,2,A\ns2,,A\n");
      state = await f.service.importFile(path, { kind: "assay-data", batchId: state.snapshot.batches[0].id, provenance: "imported" });
      const assay = state.snapshot.assays[0], original = state.snapshot.assets.find((asset) => asset.id === assay.sourceAssetIds[0]);
      expect(original.originalName).toBe("readings.csv");
      expect(assay.records[2].value).toBeNull();
      await writeFile(path, "changed after import");
      state = await f.service.analyze({ assayId: assay.id });
      expect(state.snapshot.analyses[0].assetIds).toContain(original.id);
      expect(state.snapshot.analyses[0].result.rows[0]).toMatchObject({ n: 1, readings: 2, mean: 1 });
      expect(state.snapshot.analyses[0].result.inputRawAssetId).toBe(assay.rawAssetId);
      const exported = await f.service.export();
      expect(await readFile(join(exported, original.path), "utf8")).toContain("s1,0,A");
    } finally { await f.cleanup(); }
  }, 15000);
  it("rejects a chemical result when its input structure changes during computation", async () => {
    const f = await fixture();
    try {
      const state = await f.service.state(), compoundId = state.snapshot.compounds[0].id;
      let complete;
      f.service.python = () => new Promise((resolveResult) => { complete = resolveResult; });
      const running = f.service.chemistry({ action: "properties", compoundId });
      await new Promise((resolveReady) => { const timer = setInterval(() => { if (complete) { clearInterval(timer); resolveReady(); } }, 5); });
      await f.service.mutate({ action: "addCompound", data: { id: compoundId, smiles: "CCN" } });
      complete({ ok: true, originalSmiles: "CCO", descriptors: { molecularWeight: 46.069 } });
      await expect(running).rejects.toThrow("分子记录已更新");
      expect((await f.service.state()).snapshot.analyses).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it("reads actual XLSX numeric values but does not evaluate spreadsheet formulas", async () => {
    const f = await fixture();
    try {
      const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("检测");
      sheet.addRow(["样品编号", "读数", "浓度"]); sheet.addRow(["a", 0, 1]); sheet.addRow(["b", null, 1]);
      const path = join(f.root, "assay.xlsx"); await book.xlsx.writeFile(path);
      expect(await readAssayFile(path)).toEqual([{ sampleId: "a", value: 0, concentration: 1, replicate: null, group: "" }, { sampleId: "b", value: null, concentration: 1, replicate: null, group: "" }]);
      sheet.getCell("B2").value = { formula: "1+1", result: 2 }; await book.xlsx.writeFile(path);
      await expect(readAssayFile(path)).rejects.toThrow("含公式");
    } finally { await f.cleanup(); }
  });
  it("opens the archived original and rejects a file whose fingerprint changed", async () => {
    const f = await fixture();
    try {
      const source = join(f.root, "spectrum.txt");
      await writeFile(source, "original instrument export");
      const state = await f.service.importFile(source, { kind: "other", provenance: "imported" });
      const asset = state.snapshot.assets.at(-1);
      await writeFile(source, "source overwritten after import");
      const location = await f.service.assetLocation(asset.id);
      expect(await readFile(location.path, "utf8")).toBe("original instrument export");
      await writeFile(location.path, "archive changed externally");
      await expect(f.service.assetLocation(asset.id)).rejects.toThrow("归档指纹不一致");
      await expect(f.service.assetLocation("unknown-file")).rejects.toThrow("没有这份原始资料");
    } finally { await f.cleanup(); }
  });
  it("runs external helpers from the unpacked directory in a packaged application", async () => {
    const f = await fixture();
    try {
      const appRoot = join(f.root, "app.asar"), unpacked = `${appRoot}.unpacked`;
      await writeFile(appRoot, "ASAR virtual archive placeholder");
      await mkdir(join(unpacked, "scripts"), { recursive: true });
      await writeFile(join(unpacked, "scripts", "research-chemistry.py"), "process.stdout.write(JSON.stringify({ok:true,cwd:process.cwd()}));");
      f.service.appRoot = appRoot;
      f.service.runtimeConfig = async () => ({ python: process.execPath, configPath: join(f.root, "runtime.json") });
      expect(await f.service.python({ action: "status" })).toEqual({ ok: true, cwd: unpacked });
    } finally { await f.cleanup(); }
  });
  it("archives a failed route search with its input and logs instead of inventing a route", async () => {
    const f = await fixture();
    try {
      const runId = "run-software-fixture", runtime = join(f.root, "runtime"), directory = join(runtime, "runs", runId);
      await mkdir(directory, { recursive: true });
      for (const [file, content] of Object.entries({ "targets.smi": "CCO", "config.yml": "search: fixture", "stdout.log": "No route within budget", "stderr.log": "", "provenance.json": '{"status":"no-route","fixture":true}' })) await writeFile(join(directory, file), content);
      f.service.runtimeConfig = async () => ({ configPath: join(runtime, "config.json") });
      f.service.python = async () => ({ ok: false, runId, logDirectory: directory, message: "搜索预算内无路线", routes: [], provenance: "predicted" });
      const state = await f.service.state();
      await expect(f.service.chemistry({ action: "retrosynthesis", compoundId: state.snapshot.compounds[0].id })).rejects.toThrow("运行档案已关联");
      const saved = (await f.service.state()).snapshot;
      expect(saved.analyses[0].result.ok).toBe(false);
      expect(saved.analyses[0].result.routes).toEqual([]);
      expect(saved.analyses[0].provenance).toBe("predicted");
      expect(saved.analyses[0].assetIds).toHaveLength(5);
      expect(saved.assets.every((asset) => asset.provenance === "predicted")).toBe(true);
      const exported = await f.service.export();
      const log = saved.assets.find((asset) => asset.originalName === "stdout.log");
      expect(await readFile(join(exported, log.path), "utf8")).toBe("No route within budget");
    } finally { await f.cleanup(); }
  });
  it("allows one route search at a time and releases the slot after a failure", async () => {
    const f = await fixture();
    try {
      const request = { action: "retrosynthesis", compoundId: (await f.service.state()).snapshot.compounds[0].id };
      let complete;
      f.service.python = () => new Promise((resolveResult) => { complete = resolveResult; });
      const running = f.service.chemistry(request);
      const failure = expect(running).rejects.toThrow("软件测试失败");
      await new Promise((resolveReady) => { const timer = setInterval(() => { if (complete) { clearInterval(timer); resolveReady(); } }, 5); });
      await expect(f.service.chemistry(request)).rejects.toThrow("已有候选路线搜索正在运行");
      complete({ ok: false, message: "软件测试失败" });
      await failure;
      f.service.python = async () => ({ ok: false, message: "下一次搜索已启动" });
      await expect(f.service.chemistry(request)).rejects.toThrow("下一次搜索已启动");
    } finally { await f.cleanup(); }
  });
  it.skipIf(process.platform !== "win32")("terminates a timed-out helper's child process on Windows", async () => {
    const f = await fixture();
    const pidPath = join(f.root, "worker.pid");
    try {
      const scripts = join(f.root, "scripts"); await mkdir(scripts);
      await writeFile(join(scripts, "research-chemistry.py"), `const {spawn}=require('node:child_process');const fs=require('node:fs');const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidPath)},String(worker.pid));setInterval(()=>{},1000);`);
      f.service.appRoot = f.root;
      f.service.runtimeConfig = async () => ({ python: process.execPath, configPath: join(f.root, "runtime.json") });
      await expect(f.service.python({ action: "status" }, 2500)).rejects.toThrow("超过本次时间预算");
      const workerPid = Number(await readFile(pidPath, "utf8"));
      expect(() => process.kill(workerPid, 0)).toThrow();
    } finally {
      // This PID belongs only to the disposable worker created by this fixture.
      try { process.kill(Number(await readFile(pidPath, "utf8"))); } catch { /* already stopped */ }
      await f.cleanup();
    }
  }, 15000);
});
