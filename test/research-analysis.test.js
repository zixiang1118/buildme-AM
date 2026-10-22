import { describe, expect, it } from "vitest";
import { summarizeAssay, draftResearchSection } from "../desktop/research-analysis.mjs";
import { assayRows, parseDelimited } from "../desktop/research-import.mjs";

describe("research data analysis", () => {
  it("averages technical readings without inventing independent repetitions or zero values", () => {
    const result = summarizeAssay({ endpoint: "响应", unit: "%", controls: "载体对照", provenance: "example", records: [
      { sampleId: "a", value: 10, group: "A" }, { sampleId: "a", value: 14, group: "A" },
      { sampleId: "b", value: 20, group: "A" }, { sampleId: "c", value: null, group: "A" },
    ] });
    expect(result.rows[0]).toMatchObject({ n: 2, readings: 3, mean: 16, sd: Math.sqrt(32) });
    expect(result.sourceProvenance).toBe("example");
    expect(result.warnings.some((text) => text.includes("没有补成零"))).toBe(true);
    expect(summarizeAssay({ records: [{ sampleId: "missing", value: null }] }).rows).toEqual([]);
  });
  it("keeps different concentrations and experimental groups separate", () => {
    const result = summarizeAssay({ records: [
      { sampleId: "s1", concentration: 1, value: 10, group: "control" },
      { sampleId: "s1", concentration: 2, value: 80, group: "control" },
      { sampleId: "s1", concentration: 2, value: 90, group: "candidate" },
    ] });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.n === 1 && row.sd === null)).toBe(true);
  });
  it("parses quoted CSV and preserves missing readings", () => {
    const rows = parseDelimited('\uFEFFsampleId,value,group\r\n"a,1",0,"control\nseries"\r\n"b",,"B"');
    expect(assayRows(rows)).toEqual([
      { sampleId: "a,1", value: 0, concentration: null, replicate: null, group: "control\nseries" },
      { sampleId: "b", value: null, concentration: null, replicate: null, group: "B" },
    ]);
    expect(() => assayRows([["value"], [12]])).toThrow("样品编号");
    expect(() => assayRows([["sampleId", "value"], ["x", "=1+1"]])).toThrow("不是数值");
  });
  it("does not turn planned chemistry into completed results", () => {
    const snapshot = { project: { objective: "测试研究流程", target: "测试体系" }, plans: [{ id: "p", title: "计划", version: 1, hypothesis: "待检验", steps: "比较现有条件", replicates: null }],
      runs: [], batches: [], assays: [], claims: [] };
    const methods = draftResearchSection(snapshot, "methods");
    expect(methods.evidenceIds).toEqual(["p"]);
    expect(methods.body).toContain("不能表述为已完成实验");
    expect(draftResearchSection(snapshot, "results").body).toContain("当前不能撰写数值结果");
  });
  it("uses the exact historical method for an actual run and marks the new plan separately", () => {
    const snapshot = { project: { objective: "测试版本", target: "测试体系" },
      plans: [{ id: "p", title: "方案", version: 2, steps: ["尚未执行的B步骤"], history: [{ id: "p", version: 1, title: "方案", steps: ["已执行的A步骤"] }] }],
      runs: [{ id: "r", planId: "p", planVersion: 1, status: "completed", provenance: "measured", conditions: "实际A条件" }], batches: [], assays: [], claims: [] };
    const draft = draftResearchSection(snapshot, "methods");
    expect(draft.body).toContain("实际反应所用方案 v1");
    expect(draft.body).toContain("后续或未执行计划 v2");
    expect(draft.body).toContain("已执行的A步骤");
    expect(draft.evidenceIds).toContain("r");
    snapshot.runs[0].provenance = "example";
    expect(draftResearchSection(snapshot, "methods").body).toContain("尚无实际反应记录");
    expect(draftResearchSection(snapshot, "results").body).toContain("不能作为实测收率");
  });
});
