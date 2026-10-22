import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchStore, type ResearchProvenance, type ResearchSnapshot } from "../src/core/research-store.js";

const workspaces: string[] = [];
afterEach(async () => { for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true }); });
async function fixture(): Promise<{ workspace: string; store: ResearchStore; snapshot: ResearchSnapshot; projectId: string }> {
	const workspace = await mkdtemp(join(tmpdir(), "buildme-research-")); workspaces.push(workspace);
	const store = new ResearchStore(workspace);
	const snapshot = await store.createProject({ title: "实验课题", objective: "连接反应、表征与检测证据", target: "药物化学" });
	return { workspace, store, snapshot, projectId: snapshot.project.id };
}
async function compound(store: ResearchStore, projectId: string, name = "Compound A"): Promise<string> {
	const snapshot = await store.mutate(projectId, { action: "addCompound", data: { name, smiles: "CCO", stereo: "未确定", provenance: "proposed" } });
	return snapshot.compounds.at(-1)!.id;
}
async function batch(store: ResearchStore, projectId: string, compoundId: string, code = "B-01", provenance: ResearchProvenance = "proposed"): Promise<string> {
	const snapshot = await store.mutate(projectId, { action: "recordBatch", data: { compoundId, code, purityPercent: null, provenance } });
	return snapshot.batches.at(-1)!.id;
}
async function assay(store: ResearchStore, projectId: string, batchId: string, provenance: ResearchProvenance = "measured"): Promise<ResearchSnapshot> {
	return store.mutate(projectId, { action: "recordAssay", data: { batchId, endpoint: "测试终点", method: "用户记录的方法", unit: "AU", controls: "车辆对照", records: [{ sampleId: "S-1", concentration: null, value: 4.2, replicate: 1 }, { sampleId: "S-2", concentration: 0, value: null }], provenance } });
}
function projectPath(workspace: string, projectId: string): string { return join(workspace, ".buildme", "research", "projects", projectId); }

describe("ResearchStore", () => {
	it("lists an empty workspace without creating research storage", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "buildme-research-readonly-")); workspaces.push(workspace);
		const store = new ResearchStore(workspace);
		expect(await store.listProjects()).toEqual([]);
		await expect(store.getProject(randomUUID())).rejects.toThrow("项目不存在");
		expect(await readdir(workspace)).toEqual([]);
	});
	it("reopens durable independent research records and preserves missing numeric values", async () => {
		const { workspace, store, projectId } = await fixture();
		const compoundId = await compound(store, projectId);
		const saved = await store.mutate(projectId, { action: "recordBatch", data: { compoundId, code: "batch-unknown", purityPercent: null } });
		expect(saved.batches[0]).toMatchObject({ purityPercent: null, evidenceStatus: "not-applicable", provenance: "proposed" });
		const reopened = new ResearchStore(workspace);
		expect(await reopened.getProject(projectId)).toEqual(saved);
		expect(await reopened.listProjects()).toEqual([saved.project]);
		expect(saved.revision).toBe(3);
		const changed = await reopened.mutate(projectId, { action: "updateProject", data: { title: "新名称" } });
		expect(changed.project).toMatchObject({ title: "新名称", objective: saved.project.objective, target: "药物化学" });
		expect(changed.revision).toBe(4);
	});

	it("retains exact plan versions and validates the run-to-compound chain", async () => {
		const { store, projectId } = await fixture();
		const target = await compound(store, projectId);
		let snapshot = await store.mutate(projectId, { action: "savePlan", data: { title: "方案", targetCompoundId: target, hypothesis: "待验证", steps: "原始步骤", controls: ["对照"], replicates: 3 } });
		const planId = snapshot.plans[0]!.id;
		snapshot = await store.mutate(projectId, { action: "recordRun", data: { planId, planVersion: 1, status: "failed", notes: "保留失败", yieldPercent: 0 } });
		const run = snapshot.runs[0]!;
		snapshot = await store.mutate(projectId, { action: "savePlan", data: { id: planId, steps: "修订步骤" } });
		expect(snapshot.plans[0]).toMatchObject({ version: 2, history: [{ version: 1, steps: "原始步骤" }], steps: "修订步骤" });
		expect(snapshot.runs[0]).toMatchObject({ planVersion: 1, status: "failed", yieldPercent: 0 });
		await expect(store.mutate(projectId, { action: "recordRun", data: { planId, planVersion: 3 } })).rejects.toThrow("版本不存在");
		const other = await compound(store, projectId, "Other compound");
		await expect(store.mutate(projectId, { action: "recordBatch", data: { compoundId: other, runId: run.id, code: "wrong" } })).rejects.toThrow("目标不一致");
		await expect(store.mutate(projectId, { action: "recordRun", data: { id: run.id, planVersion: 2 } })).rejects.toThrow("关联不能修改");
		expect((await store.getProject(projectId)).runs).toHaveLength(1);
	});

	it("keeps the structure identity of measured batches and historical plans stable", async () => {
		const { store, projectId } = await fixture(); const actualCompound = await compound(store, projectId, "Structure A");
		const actualBatch = await batch(store, projectId, actualCompound, "Measured batch A", "measured");
		let snapshot = await assay(store, projectId, actualBatch); const original = snapshot.compounds.find((row) => row.id === actualCompound)!;
		await expect(store.mutate(projectId, { action: "addCompound", data: { id: actualCompound, smiles: "CCC" } })).rejects.toThrow("请新建分子记录");
		await expect(store.mutate(projectId, { action: "addCompound", data: { id: actualCompound, stereo: "新指认的立体异构体" } })).rejects.toThrow("请新建分子记录");
		snapshot = await store.getProject(projectId);
		expect(snapshot.compounds.find((row) => row.id === actualCompound)).toEqual(original);
		expect(snapshot.assays[0]).toMatchObject({ batchId: actualBatch, provenance: "measured" });
		snapshot = await store.mutate(projectId, { action: "addCompound", data: { id: actualCompound, name: "Corrected display name", notes: "Clarification without changing chemical identity" } });
		expect(snapshot.compounds.find((row) => row.id === actualCompound)).toMatchObject({ name: "Corrected display name", smiles: original.smiles, stereo: original.stereo });
		const historicalTarget = await compound(store, projectId, "Old plan target"); const currentTarget = await compound(store, projectId, "New plan target");
		snapshot = await store.mutate(projectId, { action: "savePlan", data: { title: "History preserves identity", targetCompoundId: historicalTarget } }); const planId = snapshot.plans[0]!.id;
		snapshot = await store.mutate(projectId, { action: "savePlan", data: { id: planId, targetCompoundId: currentTarget } });
		expect(snapshot.plans[0]!.history[0]!.targetCompoundId).toBe(historicalTarget);
		await expect(store.mutate(projectId, { action: "addCompound", data: { id: historicalTarget, smiles: "CCN" } })).rejects.toThrow("历史版本");
		const unreferenced = await compound(store, projectId, "Unreferenced draft");
		snapshot = await store.mutate(projectId, { action: "addCompound", data: { id: unreferenced, smiles: "CCN" } });
		expect(snapshot.compounds.find((row) => row.id === unreferenced)!.smiles).toBe("CCN");
	});

	it("captures every manual assay input immutably with batch identity, hash, and nulls", async () => {
		const { workspace, store, projectId } = await fixture();
		const compoundId = await compound(store, projectId); const batchId = await batch(store, projectId, compoundId, "B-real", "measured");
		let snapshot = await assay(store, projectId, batchId);
		const first = snapshot.assays[0]!; const raw = snapshot.assets[0]!;
		const rawPath = join(projectPath(workspace, projectId), raw.path);
		const original = await readFile(rawPath);
		expect(createHash("sha256").update(original).digest("hex")).toBe(raw.sha256);
		expect(raw).toMatchObject({ batchId, assayId: first.id, kind: "assay-data", origin: "manual-entry", provenance: "measured" });
		expect(JSON.parse(original.toString()).assay.records).toEqual(first.records);
		expect(first.records[1]).toMatchObject({ value: null, concentration: 0, replicate: null });
		snapshot = await store.mutate(projectId, { action: "recordAssay", data: { id: first.id, records: [{ sampleId: "S-1", value: 9 }] } });
		expect(snapshot.assets).toHaveLength(2);
		expect(snapshot.assays[0]!.rawAssetIds).toEqual([raw.id, snapshot.assets[1]!.id]);
		expect(await readFile(rawPath)).toEqual(original);
		expect(snapshot.assays[0]!.records[0]!.value).toBe(9);
	});

	it("accepts declared manual purity while visibly marking missing characterization evidence", async () => {
		const { workspace, store, projectId } = await fixture();
		const compoundId = await compound(store, projectId);
		let snapshot = await store.mutate(projectId, { action: "recordBatch", data: { compoundId, code: "B-1", purityPercent: 97.5, provenance: "measured" } });
		expect(snapshot.batches[0]!.evidenceStatus).toBe("needs-source");
		const sourcePath = join(workspace, "original-nmr.txt"); await writeFile(sourcePath, "Original instrument file");
		snapshot = await store.registerAsset(projectId, { sourcePath, kind: "spectrum", batchId: snapshot.batches[0]!.id });
		expect(snapshot.batches[0]!.evidenceStatus).toBe("source-linked");
		const raw = snapshot.assets[0]!; await writeFile(sourcePath, "Source changed later");
		expect(await readFile(join(projectPath(workspace, projectId), raw.path), "utf8")).toBe("Original instrument file");
		expect(raw.provenance).toBe("imported");
	});

	it("binds imported assay values to exact original file IDs and rejects wrong batch or file kind", async () => {
		const { workspace, store, projectId } = await fixture(); const target = await compound(store, projectId);
		const firstBatch = await batch(store, projectId, target, "B-1"); const otherBatch = await batch(store, projectId, target, "B-2");
		const sourcePath = join(workspace, "readings.csv"); await writeFile(sourcePath, "sampleId,value\nS-1,12\n");
		let snapshot = await store.registerAsset(projectId, { sourcePath, kind: "assay-data", batchId: firstBatch }); const sourceId = snapshot.assets.at(-1)!.id;
		snapshot = await store.mutate(projectId, { action: "recordAssay", data: { batchId: firstBatch, endpoint: "Readings", method: "Imported data", records: [{ sampleId: "S-1", value: 12 }], sourceAssetIds: [sourceId], provenance: "imported" } });
		const imported = snapshot.assays[0]!;
		expect(imported.sourceAssetIds).toEqual([sourceId]);
		const captured = JSON.parse(await readFile(join(projectPath(workspace, projectId), snapshot.assets.find((item) => item.id === imported.rawAssetId)!.path), "utf8"));
		expect(captured.assay.sourceAssetIds).toEqual([sourceId]);
		snapshot = await store.registerAsset(projectId, { sourcePath, kind: "assay-data", batchId: otherBatch }); const wrongBatchId = snapshot.assets.at(-1)!.id;
		await expect(store.mutate(projectId, { action: "recordAssay", data: { id: imported.id, sourceAssetIds: [wrongBatchId] } })).rejects.toThrow("同一批次");
		snapshot = await store.registerAsset(projectId, { sourcePath, kind: "spectrum", batchId: firstBatch }); const wrongKindId = snapshot.assets.at(-1)!.id;
		await expect(store.mutate(projectId, { action: "recordAssay", data: { id: imported.id, sourceAssetIds: [wrongKindId] } })).rejects.toThrow("原始检测数据");
		const saved = await store.getProject(projectId);
		expect(saved.assays[0]!.rawAssetIds).toHaveLength(1);
		expect(saved.assays[0]!.sourceAssetIds).toEqual([sourceId]);
		expect(await readdir(join(projectPath(workspace, projectId), "assets"))).toHaveLength(saved.assets.length);
	});

	it("loads older schema-one assays with empty source file links", async () => {
		const { workspace, store, projectId } = await fixture(); const target = await compound(store, projectId); const batchId = await batch(store, projectId, target);
		const snapshot = await assay(store, projectId, batchId); Reflect.deleteProperty(snapshot.assays[0]!, "sourceAssetIds");
		await writeFile(join(projectPath(workspace, projectId), "snapshot.json"), JSON.stringify(snapshot));
		expect((await new ResearchStore(workspace).getProject(projectId)).assays[0]!.sourceAssetIds).toEqual([]);
	});

	it("serializes parallel updates across independent stores without losing records or revisions", async () => {
		const { workspace, store, projectId } = await fixture(); const otherStore = new ResearchStore(workspace);
		await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? otherStore : store).mutate(projectId, { action: "addCompound", data: { name: `Compound ${index}`, smiles: "CCO" } })));
		const snapshot = await otherStore.getProject(projectId);
		expect(snapshot.compounds).toHaveLength(24); expect(snapshot.revision).toBe(25);
		expect(new Set(snapshot.compounds.map((row) => row.name)).size).toBe(24);
		snapshot.compounds[0]!.name = "Caller changed returned object";
		expect((await store.getProject(projectId)).compounds[0]!.name).not.toBe(snapshot.compounds[0]!.name);
		expect(await readdir(projectPath(workspace, projectId))).not.toContain("write.lock");
	});

	it("checks expected revisions inside the shared write lock and rejects stale computed results", async () => {
		const { workspace, store, projectId } = await fixture(); const target = await compound(store, projectId);
		const original = await store.getProject(projectId);
		await store.mutate(projectId, { action: "addCompound", data: { id: target, smiles: "CCCC" } });
		await expect(store.mutate(projectId, { action: "addAnalysis", data: { compoundId: target, method: "Old-input computation", result: { originalSmiles: "CCO" }, provenance: "computed" } }, { expectedRevision: original.revision })).rejects.toThrow("研究记录已更新");
		const current = await store.getProject(projectId); const other = new ResearchStore(workspace);
		const results = await Promise.allSettled([store, other].map((instance, index) => instance.mutate(projectId, { action: "addAnalysis", data: { compoundId: target, method: `Compute ${index}`, result: { originalSmiles: "CCCC" }, provenance: "computed" } }, { expectedRevision: current.revision })));
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" && rejected.reason.message).toContain("研究记录已更新");
		const saved = await store.getProject(projectId); expect(saved.revision).toBe(current.revision + 1); expect(saved.analyses).toHaveLength(1);
	});

	it("prevents assistant updates from inheriting measured provenance or actual run status by omission", async () => {
		const { store, projectId } = await fixture(); const target = await compound(store, projectId);
		let snapshot = await store.mutate(projectId, { action: "savePlan", data: { title: "User plan", targetCompoundId: target } });
		const planId = snapshot.plans[0]!.id;
		snapshot = await store.mutate(projectId, { action: "recordRun", data: { planId, status: "completed", yieldPercent: 12, provenance: "measured" } });
		const runId = snapshot.runs[0]!.id;
		snapshot = await store.mutate(projectId, { action: "addClaim", data: { text: "User observation", scope: "Actual run", evidenceIds: [runId], provenance: "measured" } });
		const claimId = snapshot.claims[0]!.id;
		const actualBatch = await batch(store, projectId, target, "Actual batch", "imported");
		snapshot = await assay(store, projectId, actualBatch);
		const actualAssay = snapshot.assays[0]!.id; const before = await store.getProject(projectId);
		const updates = [
			{ action: "recordRun", data: { id: runId, yieldPercent: 99, conditions: "Invented conditions" } },
			{ action: "recordRun", data: { id: runId, status: "planned", provenance: "proposed" } },
			{ action: "addClaim", data: { id: claimId, text: "Different assertion" } },
			{ action: "recordBatch", data: { id: actualBatch, purityPercent: 99 } },
			{ action: "recordAssay", data: { id: actualAssay, records: [{ sampleId: "S-1", value: 999 }] } },
		];
		for (const update of updates) await expect(store.mutate(projectId, update, { origin: "assistant" })).rejects.toThrow("助手不能修改");
		expect(await store.getProject(projectId)).toEqual(before);
		await expect(store.mutate(projectId, { action: "addCompound", data: { name: "Invented measurement", smiles: "CO", provenance: "measured" } }, { origin: "assistant" })).rejects.toThrow("不能把生成");
		const proposed = await store.mutate(projectId, { action: "savePlan", data: { id: planId, hypothesis: "New proposed comparison", provenance: "proposed" } }, { origin: "assistant" });
		expect(proposed.plans[0]!.version).toBe(2);
	});

	it("reserves actual run state for user records while allowing explicitly labeled simulations", async () => {
		const { store, projectId } = await fixture(); const target = await compound(store, projectId);
		let snapshot = await store.mutate(projectId, { action: "savePlan", data: { title: "Plan", targetCompoundId: target } }); const planId = snapshot.plans[0]!.id;
		await expect(store.mutate(projectId, { action: "recordRun", data: { planId, status: "running" } }, { origin: "assistant" })).rejects.toThrow("执行状态");
		snapshot = await store.mutate(projectId, { action: "recordRun", data: { planId, status: "completed" } });
		await expect(store.mutate(projectId, { action: "recordRun", data: { id: snapshot.runs[0]!.id, notes: "Omitted state and provenance" } }, { origin: "assistant" })).rejects.toThrow("执行状态");
		snapshot = await store.mutate(projectId, { action: "recordRun", data: { planId, status: "completed", provenance: "example", notes: "Explicit simulation" } }, { origin: "assistant" });
		expect(snapshot.runs.at(-1)).toMatchObject({ status: "completed", provenance: "example" });
	});

	it("coordinates independent Node processes through a shared project lease", async () => {
		const { workspace, store, projectId } = await fixture();
		const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
		const moduleUrl = new URL("../src/core/research-store.ts", import.meta.url).href;
		const childWrites = (prefix: string): Promise<void> => new Promise((resolvePromise, reject) => {
			const script = `import { ResearchStore } from ${JSON.stringify(moduleUrl)}; const store = new ResearchStore(${JSON.stringify(workspace)}); for (let index=0; index<12; index++) await store.mutate(${JSON.stringify(projectId)}, {action:"addCompound",data:{name:${JSON.stringify(prefix)}+index,smiles:"CCO"}});`;
			const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "--eval", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
			child.once("error", reject); child.once("exit", (code) => { if (code === 0) resolvePromise(); else reject(new Error(`Child process failed (${code}): ${output}`)); });
		});
		await Promise.all([childWrites("Process A "), childWrites("Process B ")]);
		const snapshot = await store.getProject(projectId);
		expect(snapshot.compounds).toHaveLength(24); expect(snapshot.revision).toBe(25);
		expect(new Set(snapshot.compounds.map((row) => row.name)).size).toBe(24);
	}, 30_000);

	it("rejects cross-project and cross-batch references without partially writing", async () => {
		const { workspace, store, projectId } = await fixture(); const target = await compound(store, projectId);
		const second = await store.createProject({ title: "Other project" }); const foreign = await compound(store, second.project.id);
		const before = await store.getProject(projectId);
		await expect(store.mutate(projectId, { action: "savePlan", data: { title: "Bad", targetCompoundId: foreign } })).rejects.toThrow("当前研究项目");
		await expect(store.mutate(projectId, { action: "addCompound", data: { id: foreign, name: "Bad", smiles: "CO" } })).rejects.toThrow("当前研究项目");
		expect(await store.getProject(projectId)).toEqual(before);
		const firstBatch = await batch(store, projectId, target, "B-1"); const secondBatch = await batch(store, projectId, target, "B-2");
		const measured = await assay(store, projectId, firstBatch);
		const sourcePath = join(workspace, "batch-2.csv"); await writeFile(sourcePath, "actual raw file");
		const withAsset = await store.registerAsset(projectId, { sourcePath, kind: "assay-data", batchId: secondBatch });
		await expect(store.mutate(projectId, { action: "addAnalysis", data: { assayId: measured.assays[0]!.id, assetIds: [withAsset.assets.at(-1)!.id], method: "Compare", result: "invalid mix" } })).rejects.toThrow("批次不一致");
		await expect(store.mutate(projectId, { action: "recordAssay", data: { id: measured.assays[0]!.id, batchId: secondBatch } })).rejects.toThrow("关联不能修改");
		expect((await store.getProject(projectId)).analyses).toHaveLength(0);
	});

	it("tracks transitive evidence changes through assay, analysis and claim to manuscript section", async () => {
		const { store, projectId } = await fixture(); const target = await compound(store, projectId); const batchId = await batch(store, projectId, target);
		let snapshot = await assay(store, projectId, batchId); const assayId = snapshot.assays[0]!.id;
		snapshot = await store.mutate(projectId, { action: "addAnalysis", data: { assayId, method: "预先指定方法", summary: "解释现有数据", result: { mean: 4.2 }, provenance: "computed" } });
		const analysisId = snapshot.analyses[0]!.id;
		snapshot = await store.mutate(projectId, { action: "addClaim", data: { text: "该检测中的观察", evidenceIds: [analysisId], scope: "当前批次与检测体系", provenance: "measured" } });
		const claimId = snapshot.claims[0]!.id;
		snapshot = await store.mutate(projectId, { action: "saveSection", data: { kind: "results", title: "结果", body: "仅描述当前观察", evidenceIds: [claimId], status: "reviewed" } });
		const sectionId = snapshot.sections[0]!.id;
		expect(snapshot.sections[0]!.stale).toBe(false);
		await compound(store, projectId, "Unrelated");
		expect((await store.getProject(projectId)).sections[0]!.stale).toBe(false);
		snapshot = await store.mutate(projectId, { action: "recordAssay", data: { id: assayId, records: [{ sampleId: "S-1", value: 2 }] } });
		expect(snapshot.sections[0]).toMatchObject({ stale: true, status: "reviewed" });
		snapshot = await store.mutate(projectId, { action: "saveSection", data: { id: sectionId, body: "更新后的描述", status: "draft" } });
		expect(snapshot.sections[0]!.stale).toBe(false);
	});

	it("keeps a run's archived plan dependency stable when the next plan version is saved", async () => {
		const { store, projectId } = await fixture(); const target = await compound(store, projectId);
		let snapshot = await store.mutate(projectId, { action: "savePlan", data: { title: "Plan", targetCompoundId: target, steps: "v1" } });
		const planId = snapshot.plans[0]!.id;
		snapshot = await store.mutate(projectId, { action: "recordRun", data: { planId, status: "completed", provenance: "measured" } });
		snapshot = await store.mutate(projectId, { action: "saveSection", data: { title: "Methods", kind: "methods", body: "Executed v1", evidenceIds: [snapshot.runs[0]!.id] } });
		snapshot = await store.mutate(projectId, { action: "savePlan", data: { id: planId, steps: "v2" } });
		expect(snapshot.sections[0]!.stale).toBe(false);
	});

	it("requires traceable claims and does not treat examples or predictions as measurements", async () => {
		const { store, projectId } = await fixture(); const target = await compound(store, projectId); const batchId = await batch(store, projectId, target);
		const snapshot = await assay(store, projectId, batchId, "example");
		await expect(store.mutate(projectId, { action: "addClaim", data: { text: "No source", scope: "test" } })).rejects.toThrow("关联来源");
		await expect(store.mutate(projectId, { action: "addClaim", data: { text: "Missing source", scope: "test", evidenceIds: [randomUUID()] } })).rejects.toThrow("证据不存在");
		await expect(store.mutate(projectId, { action: "addClaim", data: { text: "Example as measured", scope: "test", evidenceIds: [snapshot.assays[0]!.id], provenance: "measured" } })).rejects.toThrow("唯一证据");
		const declaredActual = await batch(store, projectId, target, "Actual manual batch", "measured");
		await expect(store.mutate(projectId, { action: "addClaim", data: { text: "Mixed example and measured", scope: "test", evidenceIds: [snapshot.assays[0]!.id, declaredActual], provenance: "measured" } })).rejects.toThrow("不能冒充");
		const proposed = await store.mutate(projectId, { action: "addClaim", data: { text: "Example observation", scope: "示例，待实验验证", evidenceIds: [snapshot.assays[0]!.id], provenance: "example" } });
		expect(proposed.claims[0]!.provenance).toBe("example");
		await expect(store.mutate(projectId, { action: "addClaim", data: { id: proposed.claims[0]!.id, evidenceIds: [proposed.claims[0]!.id] } })).rejects.toThrow("循环");
	});

	it("rejects malformed input, missing IDs, path traversal and lossy non-finite JSON", async () => {
		const { store, projectId } = await fixture(); const target = await compound(store, projectId);
		await expect(store.getProject("../../outside")).rejects.toThrow("标识格式");
		await expect(store.getProject(randomUUID())).rejects.toThrow("项目不存在");
		await expect(store.mutate(projectId, { action: "recordBatch", data: { compoundId: target, code: "Bad", purityPercent: NaN } })).rejects.toThrow("JSON");
		await expect(store.mutate(projectId, { action: "recordBatch", data: { compoundId: target, code: "Bad", purityPercent: "97" } })).rejects.toThrow("数值不正确");
		await expect(store.mutate(projectId, { action: "recordBatch", data: { compoundId: target, code: "Bad", purityPercent: 101 } })).rejects.toThrow("数值不正确");
		await expect(store.mutate(projectId, { action: "addCompound", data: { name: "Bad", smiles: "CO", provenance: "fake" } })).rejects.toThrow("来源必须");
		await expect(store.mutate(projectId, { action: "unknown", data: {} })).rejects.toThrow("未知");
		await expect(store.mutate(projectId, { action: "addCompound", data: { name: "Bad", smiles: "CO", notes: undefined } })).rejects.toThrow("JSON");
		const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
		await expect(store.mutate(projectId, { action: "addAnalysis", data: { method: "Bad", result: cyclic } })).rejects.toThrow("JSON");
		expect((await store.getProject(projectId)).batches).toHaveLength(0);
	});

	it("refuses symlinked storage roots and tampered owned asset paths", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "buildme-research-link-")); workspaces.push(workspace);
		const outside = await mkdtemp(join(tmpdir(), "buildme-research-outside-")); workspaces.push(outside);
		await symlink(outside, join(workspace, ".buildme"), process.platform === "win32" ? "junction" : "dir");
		await expect(new ResearchStore(workspace).createProject({ title: "Bad" })).rejects.toThrow("符号链接");
		expect(await readdir(outside)).toEqual([]);
		const item = await fixture(); const target = await compound(item.store, item.projectId); const batchId = await batch(item.store, item.projectId, target);
		const snapshot = await assay(item.store, item.projectId, batchId);
		snapshot.assets[0]!.path = "assets/../../outside.txt";
		await writeFile(join(projectPath(item.workspace, item.projectId), "snapshot.json"), JSON.stringify(snapshot));
		await expect(item.store.getProject(item.projectId)).rejects.toThrow("原始文件路径");
	});

	it("exports a portable manifest, all immutable raw assets and a readable summary", async () => {
		const { workspace, store, projectId } = await fixture(); const target = await compound(store, projectId); const batchId = await batch(store, projectId, target);
		await assay(store, projectId, batchId);
		const sourcePath = join(workspace, "spectrum.dat"); await writeFile(sourcePath, Buffer.from([0, 1, 2, 255]));
		const snapshot = await store.registerAsset(projectId, { sourcePath, kind: "spectrum", batchId });
		const destination = await mkdtemp(join(tmpdir(), "buildme-research-export-")); workspaces.push(destination);
		const output = await store.exportProject(projectId, { destination });
		expect(output.startsWith(destination)).toBe(true);
		const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
		expect(manifest).toMatchObject({ format: "buildme-research-export-v1", revision: snapshot.revision, project: { id: projectId } });
		for (const asset of manifest.assets) {
			expect(asset.sourcePath).toBeUndefined();
			const contents = await readFile(join(output, asset.path));
			expect(createHash("sha256").update(contents).digest("hex")).toBe(asset.sha256);
		}
		expect(await readFile(join(output, "README.md"), "utf8")).toContain("可整体移动");
		await writeFile(join(projectPath(workspace, projectId), snapshot.assets[0]!.path), "tampered");
		await expect(store.exportProject(projectId, { destination })).rejects.toThrow("原始文件校验失败");
		expect((await store.getProject(projectId)).revision).toBe(snapshot.revision);
	});

	it("cleans up copied assets after validation failure and resumes after a failed mutation", async () => {
		const { workspace, store, projectId } = await fixture(); const sourcePath = join(workspace, "original.txt"); await writeFile(sourcePath, "original");
		await expect(store.registerAsset(projectId, { sourcePath, kind: "" })).rejects.toThrow("文件类型");
		expect(await readdir(join(projectPath(workspace, projectId), "assets"))).toEqual([]);
		expect((await store.getProject(projectId)).assets).toEqual([]);
		await compound(store, projectId); expect((await store.getProject(projectId)).revision).toBe(2);
	});
});
