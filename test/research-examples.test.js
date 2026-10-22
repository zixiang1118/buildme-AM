import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ResearchStore } from "../src/core/research-store.js";
import { createResearchExamples, readResearchExamples } from "../desktop/research-examples.mjs";

// Each case writes and verifies three complete projects; parallel Windows I/O
// needs more than the runner's default five-second budget.
const exampleTest = (title, verify) => it(title, verify, 20000);

async function fixture() {
  const parent = resolve(tmpdir()), workspace = await mkdtemp(join(parent, "buildme-research-examples-"));
  return { workspace, store: new ResearchStore(workspace), cleanup: async () => {
    expect(dirname(resolve(workspace))).toBe(parent); expect(basename(workspace)).toMatch(/^buildme-research-examples-/);
    await rm(workspace, { recursive: true, force: true });
  } };
}

describe("research teaching examples", () => {
  exampleTest("creates three distinct linked examples and preserves user projects and edits on reuse", async () => {
    const f = await fixture();
    try {
      const user = await f.store.createProject({ title: "我的真实课题", objective: "不得被教学示例覆盖" });
      const examples = await createResearchExamples(f);
      expect(examples.map((entry) => entry.key)).toEqual(["molecule", "optimization", "evidence"]);
      expect((await f.store.listProjects())).toHaveLength(4);
      const initial = await f.store.getProject(examples[0].id);
      expect(initial.compounds.slice(0, 2).every((compound) => compound.provenance === "literature" && compound.notes.includes("https://pubchem.ncbi.nlm.nih.gov/compound/"))).toBe(true);
      expect(initial.compounds[2].provenance).toBe("example");
      await f.store.mutate(examples[0].id, { action: "addCompound", data: { id: initial.compounds[0].id, name: "我的示例修改", notes: "保留我的笔记" } });
      const changed = await f.store.getProject(examples[0].id);
      expect(await createResearchExamples(f)).toEqual(examples);
      expect(await readResearchExamples(f)).toEqual(examples);
      expect(await f.store.getProject(examples[0].id)).toEqual(changed);
      expect(await f.store.getProject(user.project.id)).toEqual(user);
      expect((await f.store.listProjects())).toHaveLength(4);
      const registry = JSON.parse(await readFile(join(f.workspace, ".buildme", "research", "examples.json"), "utf8"));
      expect(registry.examples).toHaveLength(3);
      expect(registry.examples.every((entry) => entry.complete)).toBe(true);
    } finally { await f.cleanup(); }
  });

  exampleTest("retains original plan versions, a failed run and explicitly simulated provenance", async () => {
    const f = await fixture();
    try {
      const examples = await createResearchExamples(f), snapshot = await f.store.getProject(examples[1].id);
      expect(snapshot.project.objective).toMatch(/^教学示例：模拟记录/);
      expect(snapshot.plans[0]).toMatchObject({ version: 2, history: [{ version: 1, provenance: "example" }], provenance: "example" });
      expect(snapshot.runs.map((run) => [run.planVersion, run.status, run.yieldPercent])).toEqual([[1, "failed", null], [1, "completed", 42], [2, "completed", 68]]);
      expect(snapshot.batches).toHaveLength(2);
      expect(snapshot.batches.every((batch) => snapshot.runs.some((run) => run.id === batch.runId && run.status === "completed"))).toBe(true);
      expect(snapshot.batches.every((batch) => batch.purityPercent === null)).toBe(true);
      for (const collection of ["compounds", "plans", "runs", "batches", "assets", "claims", "sections"]) expect(snapshot[collection].every((entity) => entity.provenance === "example")).toBe(true);
      expect(snapshot.sections.every((section) => section.evidenceIds.length > 0 && !section.stale)).toBe(true);
    } finally { await f.cleanup(); }
  });

  exampleTest("computes sample-aware summaries while preserving missing readings and exported example sources", async () => {
    const f = await fixture();
    try {
      const examples = await createResearchExamples(f), snapshot = await f.store.getProject(examples[2].id);
      expect(snapshot.batches).toHaveLength(3); expect(snapshot.assays).toHaveLength(3); expect(snapshot.analyses).toHaveLength(3); expect(snapshot.sections).toHaveLength(3);
      for (const assay of snapshot.assays) {
        expect(assay.provenance).toBe("example");
        if (assay.endpoint.includes("候选")) expect(assay.records[17].value).toBeNull();
        expect(assay.records[0].sampleId).toBe(assay.records[1].sampleId);
        expect(assay.sourceAssetIds).toHaveLength(1);
        expect(snapshot.assets.find((asset) => asset.id === assay.sourceAssetIds[0])).toMatchObject({ batchId: assay.batchId, provenance: "example", kind: "assay-data" });
      }
      const analysis = snapshot.analyses[0];
      expect(analysis).toMatchObject({ provenance: "computed", assayId: snapshot.assays[0].id });
      expect(analysis.result).toMatchObject({ sourceExample: true, sourceProvenance: "example", inputRawAssetId: snapshot.assays[0].rawAssetId });
      expect(analysis.result.rows[0]).toMatchObject({ concentration: 0.1, n: 3, readings: 6 });
      expect(analysis.result.rows[2]).toMatchObject({ concentration: 10, n: 3, readings: 5 });
      expect(analysis.result.rows[2].mean).toBeCloseTo(46.3333333333);
      expect(analysis.result.rows.slice(4).map((row) => row.label)).toEqual(["阴性对照（示例）", "空白对照（示例）"]);
      expect(analysis.result.warnings.some((warning) => warning.includes("1 条缺失"))).toBe(true);
      expect(snapshot.claims.every((claim) => claim.provenance === "example")).toBe(true);
      expect(snapshot.sections.every((section) => section.provenance === "example" && !section.stale)).toBe(true);
      const exported = await f.store.exportProject(snapshot.project.id);
      for (const assay of snapshot.assays) {
        const asset = snapshot.assets.find((entry) => entry.id === assay.sourceAssetIds[0]), csv = await readFile(join(exported, asset.path), "utf8");
        expect(csv).toContain("provenance"); expect(csv).toContain(",example");
        if (assay.endpoint.includes("候选")) expect(csv).toMatch(/-10-3,10,,2,/);
      }
      const resultSection = snapshot.sections.find((section) => section.kind === "results");
      expect(resultSection.body).toContain("样品编号数"); expect(resultSection.body).toContain("读数数");
      expect(resultSection.evidenceIds).toContain(analysis.id);
      expect(resultSection.evidenceIds).toContain(snapshot.assays[0].sourceAssetIds[0]);
    } finally { await f.cleanup(); }
  });

  exampleTest("reads an empty workspace without creating research storage", async () => {
    const f = await fixture();
    try { expect(await readResearchExamples(f)).toEqual([]); expect(await readdir(f.workspace)).toEqual([]); }
    finally { await f.cleanup(); }
  });

  exampleTest("preserves modified teaching source files and refuses to pair them with different generated readings", async () => {
    const f = await fixture();
    try {
      const sources = join(f.workspace, ".buildme", "research", "demo-sources"); await mkdir(sources, { recursive: true });
      const path = join(sources, "example-03-A-readings.csv"), contents = "sampleId,value,provenance\nmy-edited-example,99,example\n";
      await writeFile(path, contents);
      await expect(createResearchExamples(f)).rejects.toThrow("原始资料已经修改");
      expect(await readFile(path, "utf8")).toBe(contents);
      const project = (await f.store.listProjects()).find((entry) => entry.title.includes("03"));
      const snapshot = await f.store.getProject(project.id);
      expect(snapshot.assays).toHaveLength(0); expect(snapshot.analyses).toHaveLength(0);
    } finally { await f.cleanup(); }
  });

  exampleTest("resumes a partially created set without duplicating projects or existing records", async () => {
    const f = await fixture();
    try {
      const mutate = f.store.mutate.bind(f.store); let interrupted = false;
      f.store.mutate = async (...args) => {
        if (!interrupted && args[1].action === "recordRun" && args[1].data.notes?.includes("optimization-run-a")) { interrupted = true; throw new Error("simulated interruption"); }
        return mutate(...args);
      };
      await expect(createResearchExamples(f)).rejects.toThrow("simulated interruption");
      const partialProjects = await f.store.listProjects(); expect(partialProjects).toHaveLength(2);
      const partial = await f.store.getProject(partialProjects.find((project) => project.title.includes("02")).id);
      expect(partial.runs).toHaveLength(1);
      const firstRunId = partial.runs[0].id;
      f.store.mutate = mutate;
      const examples = await createResearchExamples(f), resumed = await f.store.getProject(examples[1].id);
      expect((await f.store.listProjects())).toHaveLength(3); expect(resumed.runs).toHaveLength(3); expect(resumed.runs[0].id).toBe(firstRunId);
      expect(resumed.plans[0].version).toBe(2);
      expect(resumed.compounds).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
});
