import { validatePlatformDefinition } from "./platform-store.mjs";

const field = (id, label, type = "text", extra = {}) => ({ id, label, type, ...extra });
const records = (id, title, fields) => ({ id, title, kind: "records", fields });
const notes = (id, title) => ({ id, title, kind: "notes" });
const analysis = (sourcePageId, valueField, groupField, sampleField) => ({ id: "analysis", title: "数据分析", kind: "analysis", sourcePageId, valueField, groupField, sampleField });
const assistant = { role: "我的科研助手", instructions: "按照本平台的页面和字段帮助整理研究。区分输入数据、计算结果和待验证建议；保留来源，未知内容不补造。" };
const workflow = [{ id: "data-review", title: "导入 → 分析 → 结果记录", steps: ["import", "analyze", "report"] }];
const definition = (name, description, pages, capabilities, workflows = workflow) => validatePlatformDefinition({ name, description, pages, capabilities, assistant: structuredClone(assistant), workflows });

/** Optional editable starting points; none defines the user's research discipline. */
export const templates = [
  { id: "blank", title: "从空白搭建", description: "先建立自己的记录字段，按需要增加页面和能力。", definition: definition("我的科研平台", "由我定义研究记录、页面和工作流程。", [records("records", "我的记录", [field("name", "记录名称", "text", { required: true }), field("notes", "备注", "longtext")])], ["records", "files"], []) },
  { id: "environment", title: "环境数据工作台", description: "采样信息、检测结果和分组统计的可修改起点。", definition: definition("环境数据工作台", "登记采样与检测数据，并按采样位置或批次比较结果。", [records("samples", "采样记录", [field("sample_id", "样品编号", "text", { required: true }), field("location", "采样位置"), field("sample_date", "采样日期", "date"), field("batch", "批次"), field("measurement", "检测读数", "number"), field("notes", "现场备注", "longtext")]), analysis("samples", "measurement", "location", "sample_id"), notes("notes", "研究记录")], ["records", "files", "statistics", "charts", "notes"]) },
  { id: "materials", title: "材料实验工作台", description: "材料样品、制备条件与性能测试的可修改起点。", definition: definition("材料实验工作台", "关联材料批次、制备因素和性能数据，保存每次实验判断。", [records("experiments", "材料实验", [field("sample_id", "样品编号", "text", { required: true }), field("composition", "材料组成"), field("batch", "制备批次"), field("temperature", "制备温度", "number", { unit: "°C" }), field("property", "性能读数", "number"), field("equipment", "设备编号"), field("notes", "异常记录", "longtext")]), analysis("experiments", "property", "batch", "sample_id"), notes("notes", "实验判断")], ["records", "files", "statistics", "charts", "notes"]) },
  { id: "computation", title: "计算课题工作台", description: "计算任务、输入参数与结果比较的可修改起点。", definition: definition("计算课题工作台", "登记计算设置、来源文件和输出指标；计算程序由用户另行配置。", [records("computations", "计算任务", [field("run_id", "任务编号", "text", { required: true }), field("method", "方法名称"), field("parameters", "输入参数", "longtext"), field("seed", "随机种子", "number"), field("metric", "评价指标", "number"), field("notes", "结果说明", "longtext")]), analysis("computations", "metric", "method", "run_id"), notes("notes", "计算记录")], ["records", "files", "statistics", "charts", "notes", "simulation"]) },
];
export const platformTemplates = templates;

function inferField(token, index) {
  const match = token.trim().match(/^(.+?)(?:[（(]([^）)]+)[）)])?$/u);
  if (!match) return null;
  const label = match[1].trim(); if (!label || label.length > 200) return null;
  const annotation = match[2]?.trim() ?? "";
  let type = /(?:日期|date)/iu.test(`${label} ${annotation}`) ? "date" : /(?:备注|说明|参数|过程|notes|description)/iu.test(label) ? "longtext" : "text";
  if (/(?:数字|数值|number|温度|浓度|读数|质量|重量|时间|时长|压力|体积|容量|含量|性能|指标|效率|产率|纯度|电压|电流|重复次数)/iu.test(`${label} ${annotation}`) && !/(?:编号|名称|描述)/u.test(label)) type = "number";
  if (/^(?:%|°C|℃|K|mg|g|kg|μg|ug|mol|mmol|mL|L|nm|mm|cm|m|Pa|kPa|MPa|V|mV|A|s|min|h)(?:\/[a-zμ]+)?$/iu.test(annotation)) type = "number";
  if (/(?:文本|string|text)/iu.test(annotation)) type = "text";
  const unit = annotation && !/(?:数字|数值|number|文本|string|text|日期|date)/iu.test(annotation) ? annotation : undefined;
  return field(`custom_${index + 1}`, label, type, { ...(unit && type === "number" ? { unit } : {}) });
}
function declaredFields(requirement) {
  const match = requirement.match(/(?:字段|列名|columns|fields)\s*[：:]\s*([^。；;\n]+)/iu);
  if (!match) return [];
  return match[1].split(/[、，,|]/u).map(inferField).filter(Boolean).filter((entry, i, rows) => rows.findIndex((other) => other.label === entry.label) === i);
}
function addCapability(draft, id) { if (!draft.capabilities.includes(id)) draft.capabilities.push(id); }
function hasNegative(requirement, word) { return new RegExp(`(?:不要|不用|不需要|去掉|删除|暂不|先不)(?:[^。；;\\n]{0,8})(?:${word})|(?:${word})(?:[^。；;\\n]{0,5})(?:不要|不用|暂不|先不)`, "u").test(requirement); }
function addNotes(draft, id, title) { if (!draft.pages.some((page) => page.id === id)) draft.pages.push(notes(id, title)); addCapability(draft, "notes"); }

/** Deterministic local sketch, openly labelled; model refinement uses platform_propose. */
export function generatePlatformPreview({ requirement = "", template = "blank", definition: currentDefinition } = {}) {
  if (typeof requirement !== "string" || requirement.length > 20000) throw new Error("需求描述必须是文本且不超过 20000 字符。");
  const selected = templates.find((item) => item.id === template);
  if (!selected) throw new Error("没有这个平台模板。");
  const draft = structuredClone(currentDefinition ? validatePlatformDefinition(currentDefinition) : selected.definition);
  const warnings = [], changes = [];
  if (requirement.trim()) draft.description = requirement.trim();
  const named = requirement.match(/(?:平台名称|名字|命名为|叫做|名称)\s*[：:]?\s*[“"「]?([^”"」\n。；;，,]{1,80})/u);
  if (named) draft.name = named[1].trim();
  let firstRecords = draft.pages.find((page) => page.kind === "records");
  const explicit = declaredFields(requirement);
  if (explicit.length) {
    if (!firstRecords) { firstRecords = records("records", "我的记录", []); draft.pages.unshift(firstRecords); }
    if (!currentDefinition) firstRecords.fields = explicit;
    else for (const entry of explicit) if (!firstRecords.fields.some((existing) => existing.label === entry.label)) {
      let index = 1, id = entry.id; while (firstRecords.fields.some((existing) => existing.id === id)) id = `${entry.id}_${index++}`;
      firstRecords.fields.push({ ...entry, id });
    }
    changes.push(`已设置 ${explicit.length} 个自定义字段`); addCapability(draft, "records");
    // A template's analysis references must follow replaced field IDs.
    if (!currentDefinition) for (const page of draft.pages.filter((item) => item.kind === "analysis" && item.sourcePageId === firstRecords.id)) {
      delete page.valueField; delete page.groupField; delete page.sampleField;
    }
  }
  if (firstRecords && !explicit.length) {
    const candidates = [["temperature", "温度", "number"], ["concentration", "浓度", "number"], ["batch", "批次", "text"], ["equipment", "设备编号", "text"], ["measurement", "读数", "number"]];
    for (const [id, label, type] of candidates) if (requirement.includes(label) && !firstRecords.fields.some((existing) => existing.label.includes(label))) {
      const safeId = firstRecords.fields.some((existing) => existing.id === id) ? `${id}_extra` : id;
      firstRecords.fields.push(field(safeId, label, type)); changes.push(`增加「${label}」字段`);
    }
  }
  const wantsAnalysis = /(?:分析|统计|分组|比较|绘图|图表|plot|statistics)/iu.test(requirement);
  if (wantsAnalysis && !hasNegative(requirement, "分析|统计|图表")) {
    addCapability(draft, "statistics"); addCapability(draft, "charts");
    if (!draft.pages.some((page) => page.kind === "analysis")) draft.pages.push({ id: "analysis", title: "数据分析", kind: "analysis", ...(firstRecords ? { sourcePageId: firstRecords.id } : {}) });
  }
  if (hasNegative(requirement, "分析|统计|图表")) { draft.pages = draft.pages.filter((page) => page.kind !== "analysis"); draft.capabilities = draft.capabilities.filter((id) => !["statistics", "charts"].includes(id)); }
  for (const page of draft.pages.filter((item) => item.kind === "analysis" && item.sourcePageId)) {
    const source = draft.pages.find((item) => item.id === page.sourcePageId);
    if (!page.valueField) page.valueField = source?.fields.find((entry) => entry.type === "number")?.id;
    if (!page.groupField) page.groupField = source?.fields.find((entry) => /(?:分组|组别|批次|位置|方法)/u.test(entry.label))?.id;
    if (!page.sampleField) page.sampleField = source?.fields.find((entry) => /(?:样品编号|样本编号|任务编号)/u.test(entry.label))?.id;
    for (const key of ["valueField", "groupField", "sampleField"]) if (page[key] === undefined) delete page[key];
    if (!page.valueField) warnings.push("分析页面还没有数字字段，请在搭建面板选择要分析的数值列。");
  }
  if (/(?:记录|进度|笔记|实验判断)/u.test(requirement) && !hasNegative(requirement, "笔记")) addNotes(draft, "notes", "研究记录");
  if (/(?:文献|资料检索)/u.test(requirement) && !hasNegative(requirement, "文献")) addCapability(draft, "literature");
  if (/(?:分子|化学|反应|合成)/u.test(requirement) && !hasNegative(requirement, "化学")) addCapability(draft, "chemistry");
  if (/(?:仿真|模拟|simulation)/iu.test(requirement) && !hasNegative(requirement, "仿真|模拟")) addCapability(draft, "simulation");
  if (/(?:论文|写作)/u.test(requirement) && !hasNegative(requirement, "论文|写作")) addNotes(draft, "writing", "写作记录");
  if (hasNegative(requirement, "论文|写作")) draft.pages = draft.pages.filter((page) => page.id !== "writing");
  for (const capability of ["literature", "chemistry", "simulation"]) if (draft.capabilities.includes(capability)) warnings.push(`${{ literature: "文献", chemistry: "化学", simulation: "仿真" }[capability]}能力当前提供 Agent 指导，实际检索或计算需要配置相应工具。`);
  if (draft.pages.some((page) => page.kind === "analysis") && !draft.workflows.length) draft.workflows = structuredClone(workflow);
  return { definition: validatePlatformDefinition(draft), mode: "local", explanation: `这是本地规则生成的可修改初稿。${changes.length ? `${changes.join("；")}。` : `以「${selected.title}」为起点。`}页面、字段、能力和流程可在保存前继续调整；也可以用已配置的模型完善设计。`, warnings: [...new Set(warnings)] };
}
