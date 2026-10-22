import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { draftResearchSection, summarizeAssay } from "./research-analysis.mjs";

const DECLARATION = "教学示例：模拟记录，用于体验工作台，不是实验结果或药效证据。";
const EXAMPLES = [
  { key: "molecule", title: "【示例 01】分子设计与合成路线", target: "阿尔茨海默病小分子研究流程 · 结构与路线教学", objective: "查看有出处的参考分子及教学结构，比较分子性质与断键思路，形成需核验的研究计划。" },
  { key: "optimization", title: "【示例 02】反应条件优化与失败记录", target: "药物化学 · 反应方案版本与批次追溯", objective: "观察方案 v1/v2、失败反应和模拟收率如何关联，体验优化记录与证据回查。" },
  { key: "evidence", title: "【示例 03】活性读数到论文证据", target: "体外检测教学 · 原始资料、描述统计与论文草稿", objective: "查看两组四浓度模拟曲线与对照批次、技术重复、缺失值和证据关联草稿。" },
];
const queues = new Map();
const marker = (key) => `[buildme-example:${key}]`;
const note = (key, text) => `【教学示例】${text} ${marker(key)}`;
const examplesOnly = (text) => `【教学示例】${text} 以上内容为模拟记录，不是实测结果或药效证据。`;

async function directory(workspace, parts) {
  let path = await realpath(resolve(workspace));
  for (const part of parts) {
    path = join(path, part);
    try { await mkdir(path); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("示例资料目录必须是工作区内的普通目录。");
  }
  return path;
}

async function safeFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("示例清单和原始资料不能是符号链接或目录。");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function readManifest(path) {
  await safeFile(path);
  let contents;
  try { contents = await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return { version: 1, examples: [] }; throw error; }
  const manifest = JSON.parse(contents);
  if (manifest?.version !== 1 || !Array.isArray(manifest.examples) || manifest.examples.some((item) => !EXAMPLES.some((example) => example.key === item.key) || typeof item.id !== "string")) throw new Error("示例清单格式不正确，原有课题未被修改。");
  return manifest;
}

async function saveManifest(path, manifest) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await safeFile(path);
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await safeFile(path);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

class ExampleProject {
  constructor(store, projectId, sources) { this.store = store; this.projectId = projectId; this.sources = sources; }
  async snapshot() { return this.store.getProject(this.projectId); }
  async ensure(collection, action, key, data) {
    const snapshot = await this.snapshot();
    const existing = snapshot[collection].find((row) => JSON.stringify(row).includes(marker(key)));
    if (existing) return existing;
    const updated = await this.store.mutate(this.projectId, { action, data: { provenance: "example", ...data } }, { origin: "assistant", expectedRevision: snapshot.revision });
    return updated[collection].at(-1);
  }
  async compound(key, name, smiles, text) {
    return this.ensure("compounds", "addCompound", key, { name: `【示例】${name}`, smiles, stereo: "教学结构；未作实验结构确认", notes: note(key, text) });
  }
  async plan(key, compound, title, hypothesis, steps, extra = {}) {
    return this.ensure("plans", "savePlan", key, { title: `【示例】${title}`, targetCompoundId: compound.id, hypothesis: examplesOnly(hypothesis), steps,
      factors: { declaration: DECLARATION, ...extra.factors }, controls: "示例：比较参照结构与同一条件下的重复记录，真实对照方案待研究者确认。", replicates: 3,
      sources: { declaration: DECLARATION, seedKey: marker(key), references: "未引用真实实验文献；先核查原始文献与实验室现有方法。" }, ...extra });
  }
  async run(key, plan, planVersion, status, conditions, yieldPercent, text) {
    return this.ensure("runs", "recordRun", key, { planId: plan.id, planVersion, status, conditions: { declaration: DECLARATION, ...conditions }, yieldPercent, notes: note(key, text) });
  }
  async batch(key, compound, code, run, text) {
    return this.ensure("batches", "recordBatch", key, { compoundId: compound.id, ...(run ? { runId: run.id } : {}), code: `示例-${code}`, purityPercent: null, notes: note(key, `${text} 没有仪器表征或已确认纯度。`) });
  }
  async source(filename, contents, batch, run) {
    const snapshot = await this.snapshot();
    const existing = snapshot.assets.find((asset) => asset.originalName === filename && asset.provenance === "example" && asset.batchId === batch?.id && asset.runId === run?.id);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error("未完成的示例原始资料已经修改；已保留修改，未覆盖或关联不一致的模拟读数。");
      return existing;
    }
    const path = join(this.sources, filename);
    await safeFile(path);
    // Never replace an existing source file, including a user-edited teaching file.
    try { await writeFile(path, contents, { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (await readFile(path, "utf8") !== contents) throw new Error("未完成的示例原始资料已经修改；已保留修改，未覆盖或关联不一致的模拟读数。");
    const updated = await this.store.registerAsset(this.projectId, { sourcePath: path, kind: batch ? "assay-data" : "raw-data", provenance: "example", ...(batch ? { batchId: batch.id } : {}), ...(run ? { runId: run.id } : {}) });
    return updated.assets.at(-1);
  }
  async claim(key, text, evidenceIds, scope) {
    return this.ensure("claims", "addClaim", key, { text: examplesOnly(text), evidenceIds, scope: note(key, scope) });
  }
  async section(key, kind, title, body, evidenceIds) {
    return this.ensure("sections", "saveSection", key, { kind, title: `【示例】${title}`, body: `> ${DECLARATION}\n\n${body}\n\n${note(key, "此章节用于展示引用和回查操作；提交论文前须替换为经核验的真实证据。")}`, evidenceIds: [...new Set(evidenceIds)], status: "draft" });
  }
}

async function moleculeRoutes(project) {
  const a = await project.ensure("compounds", "addCompound", "design-a", { name: "Donepezil · 文献参考（游离碱）", smiles: "COC1=C(C=C2C(=C1)CC(C2=O)CC3CCN(CC3)CC4=CC=CC=C4)OC", stereo: "公开结构未指定立体中心；游离碱，不能混同盐型", provenance: "literature", notes: note("design-a", "公开结构参考：PubChem CID 3152，https://pubchem.ncbi.nlm.nih.gov/compound/3152；查询日期 2026-10-14。课题仅演示研究流程；结构来源不证明本项目完成合成或药效实验。") });
  const b = await project.ensure("compounds", "addCompound", "design-b", { name: "Rivastigmine (S) · 文献参考（游离碱）", smiles: "CCN(C)C(=O)OC1=CC=CC(=C1)[C@H](C)N(C)C", stereo: "PubChem 公开 (S) 结构；游离碱，不能混同盐型", provenance: "literature", notes: note("design-b", "公开结构参考：PubChem CID 77991，https://pubchem.ncbi.nlm.nih.gov/compound/77991；查询日期 2026-10-14。课题仅演示研究流程；结构来源不证明本项目完成合成或药效实验。") });
  const c = await project.compound("design-c", "N-苄基苯甲酰胺 · 路线教学结构", "O=C(NCc1ccccc1)c1ccccc1", "用于示范酰胺断键与真实候选逆合成计算；不声称其具有阿尔茨海默病治疗活性。");
  const planA = await project.plan("design-plan-a", c, "教学酰胺的路线核查", "以简单教学结构体验断键和可合成性评估；文献参考分子用作结构比较，不直接替代实验假设。", [
    "教学思路：标记酰胺键并列出候选断键位置，不提供可直接执行的反应操作条件。",
    "核查原料结构、官能团兼容性和已发表原始路线。",
    "比较直接采购与候选合成路线，记录每一步仍待核验的依据。",
    "确定真实路线后，由实验室制定操作、结构确认和纯度判定方法。",
  ], { factors: { variable: "酰胺键断键与采购/合成选择（教学）", beforeAssay: "结构、纯度、检测干扰均待确认" } });
  const planB = await project.plan("design-plan-b", b, "文献参考结构与证据核查", "把文献结构、计算结果和未来实验假设分别记录，避免把计算性质当作活性证据。", [
    "核查文献结构的立体化学与盐型，不能把不同形式视为相同实验样品。",
    "检索并核验可替代的原始文献路线，优先使用实验室已验证的方法。",
    "记录结构计算结果与路线预测，分别标记 computed 和 predicted。",
    "真实实验完成后，用具体批次连接表征与活性读数。",
  ], { factors: { variable: "参考结构、立体化学和盐型（教学）", evidenceGap: "本项目没有体外实验或体内证据" } });
  await project.run("design-run-a", planA, 1, "planned", { conditionCode: "待文献核验", decision: "尚未开展实验" }, null, "仅展示计划状态；没有实际反应、收率或产物。");
  await project.run("design-run-b", planB, 1, "planned", { conditionCode: "待实验室评审", decision: "尚未开展实验" }, null, "仅展示计划状态；没有实际反应、收率或产物。");
  const claim = await project.claim("design-claim", "已录入两个有出处的文献参考结构、一个教学酰胺和两个核查计划；可以进一步比较结构计算结果。", [a.id, b.id, c.id, planA.id, planB.id], "仅说明工作台已有的教学记录，不支持本项目药效、血脑屏障通透或合成成功判断。");
  await project.section("design-methods", "methods", "从结构假设到路线评审", "## 参考结构与研究假设\n\nDonepezil 和 Rivastigmine (S) 游离碱结构采用 PubChem 公开记录，来源标记 literature，保留立体化学与盐型说明。N-苄基苯甲酰胺为路线教学结构，来源标记 example。先核查原始文献和候选路线，再评估是否开展真实实验。\n\n## 可体验的操作\n\n1. 在分子页选择结构，运行分子性质计算。\n2. 在路线页查看教学酰胺方案，运行候选逆合成计算。\n3. 将经文献核验的方案另存为新版本，保留判断依据。\n\n本项目没有实测产物或活性结果。", [a.id, b.id, c.id, planA.id, planB.id]);
  await project.section("design-discussion", "discussion", "下一步验证问题", `## 当前可讨论的内容\n\n${claim.text}\n\n## 仍需解决\n\n- 候选路线是否有可靠原始文献支持？\n- 结构和批次纯度如何确认？\n- 活性检测是否存在非特异反应或检测干扰？\n- 计算性质能否转化为实验可检验的假设？`, [claim.id, planA.id, planB.id]);
}

async function reactionOptimization(project) {
  const compound = await project.compound("optimization-a", "对甲氧基苯甲酰胺 · 优化教学结构", "COc1ccc(C(N)=O)cc1", "所有反应、条件代号、失败观察及百分数均为教学模拟，不可用作真实操作规程。");
  await project.compound("optimization-reference", "苯甲酰胺 · 结构参照", "NC(=O)c1ccccc1", "用于说明结构参照与目标结构分别保存；没有检测数据。");
  let plan = await project.plan("optimization-plan", compound, "条件代号 A → B 的迭代记录", "在同一教学目标下比较条件代号 A 和 B，同时保留失败记录与方案版本。", [
    "模拟设计 v1：登记条件代号 A；真实参数由实验室经文献核查后填写。",
    "记录偏差、目标是否获得及无法解释的观察。",
    "有产物时另建批次；表征与纯度信息不得从路线推断。",
  ], { factors: { conditionCode: "A", parameterDetails: "教学示例省略真实试剂用量、温度与操作顺序" } });
  const failed = await project.run("optimization-failed", plan, 1, "failed", { conditionCode: "A-1", observation: "模拟：未获得可登记产物" }, null, "模拟失败：预期目标未获得；收率留空，不能把缺失结果补成 0。失败样品没有登记为已确认产物批次。");
  const runA = await project.run("optimization-run-a", plan, 1, "completed", { conditionCode: "A-2", observation: "模拟：有产物待表征" }, 42, "教学模拟完成记录；42% 是虚构数值，未对应实际称量或仪器原始文件。");
  // A partially created example may be resumed; never rewrite a user-edited v1.
  const pristineV1 = plan.version === 1 && plan.title === "【示例】条件代号 A → B 的迭代记录" && JSON.stringify(plan.factors).includes('"conditionCode":"A"') && plan.provenance === "example";
  if (pristineV1) {
    const snapshot = await project.snapshot();
    const updated = await project.store.mutate(project.projectId, { action: "savePlan", data: { id: plan.id, hypothesis: examplesOnly("在保留 v1 记录的基础上，改用条件代号 B；尚不足以证明更优条件。"),
      steps: ["模拟设计 v2：改为条件代号 B，不提供可执行实验参数。", "保持记录目标与证据要求，说明改动原因。", "追加重复验证与结构确认，不覆盖已有 v1 运行。"],
      factors: { declaration: DECLARATION, conditionCode: "B", parameterDetails: "仅使用教学条件代号" }, provenance: "example" } }, { origin: "assistant", expectedRevision: snapshot.revision });
    plan = updated.plans.find((row) => row.id === plan.id);
  }
  const versionB = plan.history.some((row) => row.version === 1) ? 2 : plan.version;
  const runB = await project.run("optimization-run-b", plan, versionB, "completed", { conditionCode: "B-1", observation: "模拟：有产物待表征" }, 68, "教学模拟完成记录；68% 是虚构数值。与 A-2 比较只有单次记录，不能称为已确定最优条件。");
  const batchA = await project.batch("optimization-batch-a", compound, "OPT-A-02", runA, "模拟 A-2 的产物档案，仅演示 run → batch 关联。");
  const batchB = await project.batch("optimization-batch-b", compound, "OPT-B-01", runB, "模拟 B-1 的产物档案，仅演示新方案版本与新批次关联。");
  const source = await project.source("example-02-condition-comparison.csv", "declaration,conditionCode,planVersion,status,simulatedYieldPercent\nexample,A-1,1,failed,\nexample,A-2,1,completed,42\nexample,B-1,2,completed,68\n");
  const claim = await project.claim("optimization-claim", "示例 B-1 的模拟数值高于 A-2；失败 A-1 和方案 v1 均保留。", [failed.id, runA.id, runB.id, source.id], "教学比较；缺乏重复验证与完整表征，不认定最优条件，不作为真实合成结果。");
  await project.section("optimization-methods", "methods", "方案迭代与批次追溯", "## 方案版本\n\n同一目标方案保留 v1 与 v2。A-1 和 A-2 引用 v1，B-1 引用 v2；新版本不覆盖旧反应。教学条件代号不代表真实实验参数。\n\n## 失败与产物记录\n\nA-1 为模拟失败，没有登记已确认产物。A-2 与 B-1 形成各自的模拟批次，结构与纯度均未确认。", [failed.id, runA.id, runB.id, batchA.id, batchB.id]);
  await project.section("optimization-results", "results", "模拟条件比较", "## 示例记录\n\n| 条件代号 | 方案版本 | 状态 | 模拟收率 |\n|---|---:|---|---:|\n| A-1 | v1 | failed | 未记录 |\n| A-2 | v1 | completed | 42%（虚构） |\n| B-1 | v2 | completed | 68%（虚构） |\n\n缺失收率保持空值。每个完成条件只有一次模拟记录，且没有实际称量或谱图，不能据此确认最佳条件。\n\n可在证据标签回到对应反应，查看当时采用的方案版本。", [claim.id, failed.id, runA.id, runB.id, source.id]);
}

function controlRecords(letter) {
  const records = [];
  for (const [code, group, values] of [["NC", "阴性对照（示例）", [99, 100, 101]], ["BL", "空白对照（示例）", [0.5, 0.7, 0.9]]]) {
    values.forEach((value, sample) => { for (let replicate = 1; replicate <= 2; replicate++) records.push({ sampleId: `${letter}-${code}-${sample + 1}`, concentration: 0, value: value + (replicate === 1 ? -0.2 : 0.2), replicate, group }); });
  }
  return records;
}

function assayRecords(letter, doseValues) {
  const records = [];
  [0.1, 1, 10, 100].forEach((concentration, dose) => {
    doseValues[dose].forEach((value, sample) => {
      for (let replicate = 1; replicate <= 2; replicate++) records.push({ sampleId: `${letter}-${concentration}-${sample + 1}`, concentration,
        value: dose === 2 && sample === 2 && replicate === 2 ? null : value + (replicate === 1 ? -1 : 1), replicate, group: `候选 ${letter}（示例）` });
    });
  });
  return [...records, ...controlRecords(letter)];
}

async function assayEvidence(project) {
  const structures = [
    ["A", "苯甲酰胺", "NC(=O)c1ccccc1", [[96, 98, 95], [82, 84, 86], [43, 47, 50], [15, 17, 19]]],
    ["B", "对甲氧基苯甲酰胺", "COc1ccc(C(N)=O)cc1", [[98, 99, 97], [92, 94, 93], [68, 72, 70], [38, 40, 42]]],
    ["CTRL", "对照档案（水，仅表示模拟车辆对照）", "O", null],
  ];
  const assays = [], analyses = [];
  for (const [letter, name, smiles, values] of structures) {
    const compound = await project.compound(`assay-compound-${letter}`, `${letter} · ${name}`, smiles, letter === "CTRL" ? "模拟车辆与空白对照的档案载体，不是候选药物。" : "仅为教学检测档案选用的结构；未测试其真实生物活性。");
    const batch = await project.batch(`assay-batch-${letter}`, compound, `SCREEN-${letter}-01`, null, "模拟样品批次，未对应实际制备或结构确认。");
    const records = values ? assayRecords(letter, values) : controlRecords(letter);
    const source = await project.source(`example-03-${letter}-readings.csv`, "sampleId,concentration,value,replicate,group,provenance\n" + records.map((row) => `${row.sampleId},${row.concentration},${row.value ?? ""},${row.replicate},${row.group},example`).join("\n") + "\n", batch);
    const assay = await project.ensure("assays", "recordAssay", `assay-input-${letter}`, { batchId: batch.id, endpoint: values ? `【示例】候选 ${letter} 残余 AChE 活性` : "【示例】阴性与空白对照板", unit: "% 相对溶剂对照", records, sourceAssetIds: [source.id],
      method: note(`assay-input-${letter}`, "虚构的归一化读数，仅展示导入和统计流程；0.1、1、10、100 为示例浓度（μM），相对溶剂对照百分数为预设模拟值，不是由仪器数据计算所得。不是实验操作方法或真实活性检测。"),
      controls: { declaration: DECLARATION, negative: "阴性对照：模拟无候选化合物的溶剂对照", blank: "空白对照：模拟背景读数", technicalReplicates: "每组 3 个样品编号 × 2 条技术读数；候选组 10 μM 第 3 个样品第 2 条读数缺失。先在样品内平均。", independentSamples: "不同样品编号不自动证明独立制备；真实设计须核验。" } });
    const result = { ...summarizeAssay(assay), sourceExample: true, declaration: DECLARATION };
    const analysis = await project.ensure("analyses", "addAnalysis", `assay-analysis-${letter}`, { assayId: assay.id, assetIds: [source.id, assay.rawAssetId], provenance: "computed",
      method: `【示例计算】样品内平均 → 样品间描述统计 ${marker(`assay-analysis-${letter}`)}`,
      summary: values ? "【教学示例】每个浓度通常 6 条有效读数对应 3 个样品编号；10 μM 有 1 条缺失、5 条有效读数，仍对应 3 个有数值的样品编号。先在样品内平均，不按 6 个独立样品统计。所有原始数值均为虚构。" : "【教学示例】阴性、空白对照各 6 条技术读数对应 3 个样品编号。所有原始数值均为虚构。",
      result });
    assays.push(assay); analyses.push(analysis);
  }
  const claim = await project.claim("assay-claim", "候选 A 的 10 μM 模拟均值约为 46.33% 相对溶剂对照，来自 3 个有数值的样品编号和 5 条有效读数；1 条缺失保留为空。", [assays[0].id, analyses[0].id, ...assays[0].sourceAssetIds], "仅描述模拟残余活性；没有显著性检验、IC50、药效或阿尔茨海默病治疗结论。");
  await project.claim("assay-limit", "两个候选的四浓度示例曲线与对照批次保留原始 CSV；不同浓度的模拟均值仅展示统计和图表，不证明靶点作用。", [...assays.map((assay) => assay.id), ...analyses.map((analysis) => analysis.id)], "教学流程；不同结构仅使用一个模拟批次，独立性、重复验证和检测干扰仍待核查。");
  const snapshot = await project.snapshot();
  for (const kind of ["methods", "results", "discussion"]) {
    const draft = draftResearchSection(snapshot, kind);
    await project.section(`assay-paper-${kind}`, kind, draft.title, draft.body, [...draft.evidenceIds, ...analyses.map((analysis) => analysis.id), ...assays.flatMap((assay) => assay.sourceAssetIds), ...(kind === "discussion" ? [claim.id] : [])]);
  }
}

/** Explicit teaching projects. Repeated calls preserve user edits and resume interrupted initial creation. */
export async function createResearchExamples({ store, workspace }) {
  const queueKey = resolve(workspace).toLowerCase();
  const previous = queues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const root = await directory(workspace, [".buildme", "research"]);
    const sources = await directory(workspace, [".buildme", "research", "demo-sources"]);
    const path = join(root, "examples.json"), manifest = await readManifest(path);
    const result = [];
    for (const example of EXAMPLES) {
      let entry = manifest.examples.find((item) => item.key === example.key);
      let snapshot;
      if (entry) {
        try { snapshot = await store.getProject(entry.id); } catch (error) { if (!error.message.includes("项目不存在")) throw error; }
      }
      if (!snapshot) {
        // Recover the tiny interruption window between project creation and registry save.
        const existing = (await store.listProjects()).find((project) => project.title === example.title && project.objective === DECLARATION + example.objective);
        snapshot = existing ? await store.getProject(existing.id) : await store.createProject({ title: example.title, objective: DECLARATION + example.objective, target: example.target });
        entry = { key: example.key, id: snapshot.project.id, title: snapshot.project.title, complete: false };
        manifest.examples = manifest.examples.filter((item) => item.key !== example.key); manifest.examples.push(entry);
        await saveManifest(path, manifest);
      }
      if (!entry.complete) {
        const project = new ExampleProject(store, entry.id, sources);
        if (example.key === "molecule") await moleculeRoutes(project);
        else if (example.key === "optimization") await reactionOptimization(project);
        else await assayEvidence(project);
        entry.complete = true;
        await saveManifest(path, manifest);
      }
      result.push({ id: entry.id, title: (await store.getProject(entry.id)).project.title, key: example.key });
    }
    return result;
  });
  queues.set(queueKey, current);
  try { return await current; } finally { if (queues.get(queueKey) === current) queues.delete(queueKey); }
}

/** Read registered examples without creating directories or altering user records. */
export async function readResearchExamples({ store, workspace }) {
  const root = await realpath(resolve(workspace));
  let current = root;
  for (const part of [".buildme", "research"]) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("示例资料目录必须是工作区内的普通目录。");
  }
  const manifest = await readManifest(join(current, "examples.json"));
  const result = [];
  for (const definition of EXAMPLES) {
    const entry = manifest.examples.find((item) => item.key === definition.key && item.complete);
    if (!entry) continue;
    try {
      const snapshot = await store.getProject(entry.id);
      result.push({ id: entry.id, title: snapshot.project.title, key: entry.key });
    } catch (error) { if (!error.message.includes("项目不存在")) throw error; }
  }
  return result;
}
