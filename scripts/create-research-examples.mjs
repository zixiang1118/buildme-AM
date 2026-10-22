import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchService } from "../desktop/research-service.mjs";
import { createResearchExamples } from "../desktop/research-examples.mjs";

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!option("workspace") || !option("user-data")) throw new Error("Provide explicit --workspace=<directory> and --user-data=<directory>.");
const workspace = resolve(option("workspace")), userData = resolve(option("user-data"));
await mkdir(workspace, { recursive: true });
await mkdir(userData, { recursive: true });
const service = new ResearchService({ appRoot: fileURLToPath(new URL("..", import.meta.url)), userData, getWorkspace: async () => workspace });
const { store } = await service.context();
const exampleProjects = await createResearchExamples({ store, workspace });
let calculations = 0;
for (const project of exampleProjects) {
  let snapshot = await store.getProject(project.id);
  for (const compound of snapshot.compounds) {
    if (snapshot.analyses.some(analysis => analysis.compoundId === compound.id && analysis.result?.action === "properties" && analysis.result.originalSmiles === compound.smiles && analysis.result.ok)) continue;
    const result = await service.python({ action: "properties", smiles: compound.smiles, name: compound.name });
    if (!result.ok) throw new Error(result.message || result.error || "示例分子计算未完成。");
    const fresh = await store.getProject(project.id), current = fresh.compounds.find(item => item.id === compound.id);
    if (!current || current.smiles !== compound.smiles) throw new Error("示例结构在计算期间变化，请重新运行。");
    await store.mutate(project.id, { action: "addAnalysis", data: { compoundId: compound.id, method: "RDKit 分子结构与描述符计算", summary: `${compound.name} 的真实结构计算（演示）`, result, provenance: "computed", evidenceIds: [compound.id] } }, { origin: "assistant", expectedRevision: fresh.revision });
    calculations++;
    snapshot = await store.getProject(project.id);
  }
  if (project.key === "molecule") {
    const analyses = snapshot.analyses.filter(analysis => analysis.compoundId && analysis.result?.action === "properties" && analysis.result.ok);
    const title = "真实计算演示：结构、性质与立体信息比较";
    if (!snapshot.sections.some(section => section.title === title)) {
      const rows = analyses.map(analysis => {
        const compound = snapshot.compounds.find(item => item.id === analysis.compoundId), d = analysis.result.descriptors;
        return `| ${compound.name} | ${d.molecularFormula} | ${d.molecularWeight.toFixed(3)} | ${d.logP.toFixed(3)} | ${d.tpsa.toFixed(2)} |`;
      });
      await store.mutate(project.id, { action: "saveSection", data: { kind: "results", title, provenance: "computed", status: "draft",
        body: `# ${title}\n\n以下数值由本机 RDKit 根据已记录 SMILES 实际计算，不是模拟的实验测量。公开参考分子来源记录在分子备注中；教学酰胺不代表已验证的 AD 候选药物。\n\n| 分子 | 分子式 | 分子量 | 计算 LogP | TPSA（Å²） |\n|---|---|---:|---:|---:|\n${rows.join("\n")}\n\n描述符用于比较与提出下一步研究问题，不能证明入脑、抑制酶活性或治疗有效。盐型与立体信息需在实验前确认。`,
        evidenceIds: [...analyses.map(item => item.id), ...analyses.map(item => item.compoundId)],
      } }, { origin: "assistant" });
    }
    if (process.argv.includes("--retrosynthesis")) {
      const target = snapshot.compounds.find(compound => compound.provenance === "example");
      if (target && !snapshot.analyses.some(analysis => analysis.compoundId === target.id && analysis.result?.action === "retrosynthesis" && analysis.result.ok)) {
        console.log("EXAMPLES_PROGRESS actual route search started for teaching amide");
        await service.select(project.id);
        await service.chemistry({ action: "retrosynthesis", compoundId: target.id });
      }
    }
  }
}
await service.select(exampleProjects[0].id);
console.log(JSON.stringify({ ok: true, workspace, examples: exampleProjects, newRealCalculations: calculations }, null, 2));
