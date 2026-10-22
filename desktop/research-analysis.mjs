/** Local descriptive analysis. Technical readings are averaged within a sample. */
export function summarizeAssay(assay) {
  const groups = new Map();
  const warnings = [];
  let missing = 0;
  if (!Array.isArray(assay.records) || !assay.records.length) throw new Error("请先录入实验读数。");
  for (const record of assay.records) {
    if (record.value === null || record.value === undefined) { missing++; continue; }
    if (typeof record.value !== "number" || !Number.isFinite(record.value)) throw new Error("实验读数必须是有限数值。");
    if (!record.sampleId?.trim()) throw new Error("每条读数需要样品编号，以区分独立样品和重复检测。");
    const concentration = record.concentration ?? null;
    const label = record.group?.trim() || (concentration === null ? "全部样品" : `浓度 ${concentration}`);
    const key = JSON.stringify([label, concentration]);
    if (!groups.has(key)) groups.set(key, { label, concentration, samples: new Map(), readings: 0 });
    const group = groups.get(key);
    const values = group.samples.get(record.sampleId) ?? [];
    values.push(record.value);
    group.samples.set(record.sampleId, values);
    group.readings++;
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (missing) warnings.push(`${missing} 条缺失读数未参与计算，原记录仍保留；没有补成零。`);
  if (!groups.size) warnings.push("目前没有可计算的数值读数。");
  const rows = [...groups.values()].map((group) => {
    const units = [...group.samples.values()].map(mean).sort((a, b) => a - b);
    const average = mean(units), n = units.length;
    const sd = n > 1 ? Math.sqrt(units.reduce((sum, value) => sum + (value - average) ** 2, 0) / (n - 1)) : null;
    if (group.readings > n) warnings.push(`${group.label}：重复检测已先在样品内平均，${group.readings} 条读数对应 ${n} 个样品编号。`);
    if (n < 2) warnings.push(`${group.label}：只有一个样品编号，无法估计样品间标准差。`);
    return { label: group.label, concentration: group.concentration, n, readings: group.readings, mean: average,
      median: n % 2 ? units[Math.floor(n / 2)] : (units[n / 2 - 1] + units[n / 2]) / 2,
      sd, min: units[0], max: units[n - 1], samples: [...group.samples.keys()] };
  });
  warnings.push("样品编号的不同不自动证明实验独立性；请核对独立制备、批次和配对关系。");
  if (!assay.unit) warnings.push("检测结果尚未填写单位。");
  if (!assay.controls) warnings.push("检测对照尚未记录。");
  return { endpoint: assay.endpoint, unit: assay.unit || "未填写", method: "按条件分组；样品内平均重复检测；样品间描述统计",
    ...(assay.rawAssetId ? { inputRawAssetId: assay.rawAssetId, inputAssayUpdatedAt: assay.updatedAt } : {}),
    rows, warnings, provenance: "computed", sourceProvenance: assay.provenance,
    inference: "未进行显著性检验、IC50 拟合或疗效判定。进一步推断需要完整实验设计和相应分析。" };
}

const number = (value) => value === null || value === undefined ? "未记录" : Number(value).toLocaleString("zh-CN", { maximumSignificantDigits: 6 });
const note = (text) => text ? (typeof text === "object" ? JSON.stringify(text) : text) : "待补充";
const evidenceTag = (entity) => `[${entity.id}]`;
const SOURCE = { measured: "用户录入实测", imported: "导入资料", literature: "文献资料", computed: "数据计算", predicted: "计算预测", example: "示例数据", proposed: "待验证建议" };
const sourceLabel = (entity) => SOURCE[entity.provenance] || "来源待补充";
const isActual = (entity) => ["measured", "imported"].includes(entity.provenance);

/** Evidence-linked factual draft; richer prose can be requested from the connected model. */
export function draftResearchSection(snapshot, kind) {
  const titles = { methods: "实验方法草稿", results: "实验结果草稿", discussion: "讨论与下一步实验草稿" };
  if (!Object.hasOwn(titles, kind)) throw new Error("请选择方法、结果或讨论。");
  const evidenceIds = new Set();
  const lines = [`# ${titles[kind]}`, "", "本草稿依据本项目当前记录整理，需作者复核；未填写信息保留为待补充。", ""];
  const add = (entity) => { evidenceIds.add(entity.id); return evidenceTag(entity); };
  if (kind === "methods") {
    lines.push(`研究目标：${note(snapshot.project.objective)}。研究靶点或体系：${note(snapshot.project.target)}。`, "");
    if (!snapshot.runs.some((run) => isActual(run) && run.status !== "planned")) lines.push("尚无实际反应记录。以下为实验计划，不能表述为已完成实验。", "");
    const executed = snapshot.runs.filter((run) => isActual(run) && run.status !== "planned");
    const usedVersions = new Set(executed.map((run) => `${run.planId}:${run.planVersion}`));
    const renderPlan = (plan, heading, reference) => {
      const steps = Array.isArray(plan.steps) ? plan.steps : typeof plan.steps === "string" ? plan.steps.split(/\r?\n/u).filter(Boolean) : [plan.steps];
      lines.push(`## ${plan.title}（${heading} v${plan.version}） ${reference}`, `待验证假设：${note(plan.hypothesis)}`,
        ...steps.map((step, i) => `${i + 1}. ${typeof step === "string" ? step : JSON.stringify(step)}`),
        `对照：${note(typeof plan.controls === "string" ? plan.controls : JSON.stringify(plan.controls))}。独立重复安排：${number(plan.replicates)}。`, "");
    };
    for (const key of usedVersions) {
      const [planId, versionText] = key.split(":"), version = Number(versionText);
      const current = snapshot.plans.find((plan) => plan.id === planId);
      const historical = current?.version === version ? current : current?.history?.find((plan) => plan.version === version);
      const relatedRuns = executed.filter((run) => run.planId === planId && run.planVersion === version);
      if (historical) renderPlan(historical, "实际反应所用方案", relatedRuns.map(add).join("、"));
      else lines.push(`待复核：实验引用的方案 ${planId} v${version} 未找到。`);
    }
    for (const plan of snapshot.plans) {
      if (!usedVersions.has(`${plan.id}:${plan.version}`)) renderPlan(plan, "后续或未执行计划", add(plan));
    }
    for (const run of snapshot.runs) lines.push(`反应记录 ${add(run)}（${sourceLabel(run)}）：采用方案 ${run.planId} 的 v${run.planVersion}，状态为 ${run.status}；${isActual(run) && run.status !== "planned" ? "记录的实际条件" : "计划或示例条件"}：${note(run.conditions)}；偏差与观察：${note(run.notes)}。`);
    for (const assay of snapshot.assays) lines.push(`检测记录 ${add(assay)}（${sourceLabel(assay)}）：测试批次 ${assay.batchId}，终点 ${assay.endpoint}，单位 ${note(assay.unit)}；方法：${note(assay.method)}；对照：${note(assay.controls)}。`);
  } else if (kind === "results") {
    if (!snapshot.batches.length && !snapshot.assays.length) lines.push("待补充：实际产物批次、表征资料和检测读数。当前不能撰写数值结果。");
    for (const run of snapshot.runs) lines.push(`反应 ${add(run)}（${sourceLabel(run)}）状态：${run.status}；${isActual(run) && run.status !== "planned" ? "记录收率" : "计划或示例数值，不能作为实测收率"}：${number(run.yieldPercent)}${run.yieldPercent == null ? "" : "%"}；观察备注：${note(run.notes)}。`);
    for (const batch of snapshot.batches) lines.push(`批次 ${batch.code} ${add(batch)}（${sourceLabel(batch)}）：化合物 ${batch.compoundId}，${isActual(batch) ? "用户记录纯度" : "计划或示例数值，不能作为实测纯度"} ${number(batch.purityPercent)}${batch.purityPercent == null ? "" : "%"}。${note(batch.notes)}。结构确认依据需核对对应表征文件。`);
    for (const assay of snapshot.assays) {
      const result = summarizeAssay(assay);
      const batch = snapshot.batches.find((value) => value.id === assay.batchId);
      lines.push("", `### ${assay.endpoint} ${add(assay)}`, `批次：${assay.batchId}；来源：${assay.provenance}。`,
        ...(batch && !isActual(batch) ? [`关联批次来源为${sourceLabel(batch)}，以下读数不能自动作为已完成药化研究的证据。`] : []),
        "| 条件 | 样品编号数 | 读数数 | 均值 | 样品间标准差 |", "|---|---:|---:|---:|---:|");
      for (const row of result.rows) lines.push(`| ${row.label.replaceAll("|", "\\|")} | ${row.n} | ${row.readings} | ${number(row.mean)} ${result.unit} | ${number(row.sd)} |`);
      lines.push("", ...result.warnings.map((warning) => `- ${warning}`));
    }
  } else {
    lines.push("## 已记录的观察与解释", "");
    if (!snapshot.claims.length) lines.push("待补充：将具体观察关联到反应、批次、表征或检测证据后，再形成可讨论的结论。");
    for (const claim of snapshot.claims) {
      lines.push(`- ${claim.text} ${add(claim)}；来源类别：${claim.provenance}；适用范围：${note(claim.scope)}；依据：${claim.evidenceIds.map((id) => `[${id}]`).join("、") || "待补充"}。`);
      for (const id of claim.evidenceIds) evidenceIds.add(id);
    }
    lines.push("", "## 待验证与局限", "", "- 核对产物结构、纯度、检测干扰及不同批次的可比性。",
      "- 依据已有结果选择验证实验，记录竞争性解释与失败结果。",
      "- 计算性质、合成路线预测和体外检测结果分别报告；治疗效果需要相应层级的证据。",
      "- 待补充：与已核验原始文献的比较，以及能够区分候选解释的下一轮实验。");
  }
  return { kind, title: titles[kind], body: lines.join("\n"), evidenceIds: [...evidenceIds], status: "draft" };
}
