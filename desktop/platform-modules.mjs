import { createHash, randomUUID } from "node:crypto";
import { assertResearchJson, schemaObject, schemaArray, schemaString, schemaId, schemaUnique, validateResearchPages, validateResearchCapabilities } from "./platform-schema.mjs";

const field = (id, label, type = "text", extra = {}) => ({ id, label, type, ...extra });
const records = (moduleId, title, fields, suffix = "") => ({ id: `module_${moduleId}${suffix}`, moduleId, title, kind: "records", fields });
const notes = (moduleId, title, fields) => ({ id: `module_${moduleId}`, moduleId, title, kind: "notes", fields });
const numericPages = (moduleId, title, valueLabel) => [
  records(moduleId, `${title} · 数据`, [field("sample_id", "样本 / 运行编号", "text", { required: true }), field("group", "分组 / 方法"), field("value", valueLabel, "number"), field("notes", "数据说明", "longtext")], "_data"),
  { id: `module_${moduleId}_results`, moduleId, title: `${title} · 结果`, kind: "analysis", sourcePageId: `module_${moduleId}_data`, valueField: "value", groupField: "group", sampleField: "sample_id" },
];

/** Modules share the existing portable page schema; none installs an executable runtime. */
export const RESEARCH_MODULES = [
  {
    id: "datasets", title: "数据集管理", description: "登记数据来源、版本和文件，整理可复用的数据集。", group: "计算与数据", color: "#4d79d8", icon: "database",
    pages: [records("datasets", "数据集管理", [field("name", "数据集名称", "text", { required: true }), field("version", "版本"), field("source", "数据来源"), field("format", "文件格式"), field("rows", "数据量", "number"), field("notes", "数据说明", "longtext")])], capabilities: ["records", "files"],
  },
  {
    id: "code", title: "代码运行", description: "保存脚本、参数和运行记录，交给已配置的 Agent 执行。", group: "计算与数据", color: "#8b70cf", icon: "code",
    pages: [records("code", "代码运行", [field("run_id", "运行名称", "text", { required: true }), field("script", "脚本 / 命令", "longtext"), field("parameters", "运行参数", "longtext"), field("environment", "运行环境"), field("status", "实际运行状态", "select", { options: ["尚未运行", "运行中", "已完成", "失败"] }), field("log", "执行结果 / 日志", "longtext")])], capabilities: ["records", "files", "notes"],
  },
  {
    id: "comparison", title: "实验比较", description: "记录不同条件的指标，比较分组与重复实验结果。", group: "计算与数据", color: "#d6924e", icon: "compare",
    pages: numericPages("comparison", "实验比较", "比较指标"), capabilities: ["records", "files", "statistics", "charts"],
  },
  {
    id: "reports", title: "图表与报告", description: "汇集图表、来源说明和结果报告，沉淀研究产出。", group: "计算与数据", color: "#cb6b86", icon: "chart",
    pages: [notes("reports", "图表与报告", [field("title", "图表 / 报告标题", "text", { required: true }), field("body", "报告正文 / 图表说明", "longtext"), field("source", "数据与分析来源", "longtext"), field("limitations", "方法与结果限制", "longtext")])], capabilities: ["notes", "files", "charts"],
  },
  {
    id: "samples", title: "样本管理", description: "管理样本编号、批次和保存位置，保留来源信息。", group: "实验与样本", color: "#57a292", icon: "sample",
    pages: [records("samples", "样本管理", [field("sample_id", "样本编号", "text", { required: true }), field("source", "样本来源"), field("batch", "批次"), field("location", "保存位置"), field("date", "采集日期", "date"), field("notes", "样本说明", "longtext")])], capabilities: ["records", "files"],
  },
  {
    id: "protocols", title: "实验方案", description: "编写实验目标、对照、步骤和判断标准。", group: "实验与样本", color: "#6b98c6", icon: "protocol",
    pages: [notes("protocols", "实验方案", [field("title", "方案名称", "text", { required: true }), field("objective", "实验目标 / 假设", "longtext"), field("controls", "变量与对照", "longtext"), field("body", "实验步骤", "longtext"), field("criteria", "预期结果与判断标准", "longtext")])], capabilities: ["notes", "files"],
  },
  {
    id: "experiments", title: "实验记录", description: "记录实际操作、条件、结果与异常，保留实验过程。", group: "实验与样本", color: "#b49c51", icon: "experiment",
    pages: [records("experiments", "实验记录", [field("experiment_id", "实验编号", "text", { required: true }), field("protocol", "关联方案"), field("sample_id", "样本编号"), field("date", "实验日期", "date"), field("conditions", "实际条件与操作", "longtext"), field("value", "结果读数", "number"), field("notes", "观察与异常", "longtext")])], capabilities: ["records", "files", "notes"],
  },
  {
    id: "analysis", title: "数据分析", description: "导入或录入数值数据，计算分组统计并查看图表。", group: "计算与数据", color: "#5d87b0", icon: "analysis",
    pages: numericPages("analysis", "数据分析", "测量 / 指标数值"), capabilities: ["records", "files", "statistics", "charts"],
  },
  {
    id: "search", title: "检索记录", description: "保存检索词、数据源、筛选条件和每次检索结果。", group: "文献与写作", color: "#a084bc", icon: "search",
    pages: [records("search", "检索记录", [field("query", "检索词 / 检索式", "text", { required: true }), field("database", "数据库 / 数据源"), field("date", "检索日期", "date"), field("filters", "检索范围与条件", "longtext"), field("count", "结果数量", "number"), field("notes", "结果与来源链接", "longtext")])], capabilities: ["records", "files", "literature"],
  },
  {
    id: "screening", title: "文献筛选", description: "整理文献信息，记录纳入、排除和待定的依据。", group: "文献与写作", color: "#649b78", icon: "literature",
    pages: [records("screening", "文献筛选", [field("title", "文献标题", "text", { required: true }), field("authors", "作者"), field("year", "年份", "number"), field("doi", "DOI / 来源链接"), field("decision", "筛选结论", "select", { options: ["待筛选", "纳入", "排除", "待定"] }), field("reason", "筛选依据与证据", "longtext")])], capabilities: ["records", "files", "literature"],
  },
  {
    id: "writing", title: "综合写作", description: "组织研究证据与章节草稿，记录引用和待核对内容。", group: "文献与写作", color: "#bc815f", icon: "writing",
    pages: [notes("writing", "综合写作", [field("title", "章节 / 草稿标题", "text", { required: true }), field("body", "正文草稿", "longtext"), field("evidence", "证据与引用来源", "longtext"), field("pending", "待核对内容", "longtext")])], capabilities: ["notes", "files", "literature"],
  },
];

export const RESEARCH_MODULE_IDS = RESEARCH_MODULES.map((module) => module.id);

/** Canonical, reusable module data. Page identifiers are isolated across modules. */
export function validateResearchModule(input) {
  schemaObject(input, "自定义模块"); assertResearchJson(input);
  if (JSON.stringify(input).length > 1_000_000) throw new Error("自定义模块不能超过 100 万字符。");
  const moduleId = input.id === undefined ? `custom_${randomUUID().replaceAll("-", "")}` : schemaId(input.id, "模块");
  if (!/^custom_[a-z0-9][a-z0-9_-]{0,55}$/u.test(moduleId)) throw new Error("自定义模块编号必须以 custom_ 开头，不能覆盖内置模块。");
  const title = schemaString(input.title, "模块名称", 200).trim();
  if (!title) throw new Error("模块名称不能为空。");
  const group = schemaString(input.group ?? "自定义", "模块分类", 80).trim();
  if (!group) throw new Error("模块分类不能为空。");
  const color = input.color ?? "#649b78";
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/iu.test(color)) throw new Error("模块颜色必须是六位十六进制颜色。");
  const rawPages = schemaArray(input.pages, "模块页面", 20);
  if (!rawPages.length) throw new Error("自定义模块至少需要一个页面。");
  const pages = rawPages.map((page) => {
    schemaObject(page, "模块页面");
    if (page.moduleId !== undefined && page.moduleId !== moduleId) throw new Error("自定义模块页面不能引用其他模块。");
    const result = { ...page }; delete result.moduleId; return result;
  });
  // Validate local references before assigning the namespace, so external page IDs
  // and malformed source fields never become silent empty analysis pages.
  const validated = validateResearchPages(pages, { max: 20 });
  for (const page of validated) {
    if (["records", "notes"].includes(page.kind) && !page.fields.length) throw new Error("自定义模块记录和笔记页面至少需要一个字段。");
    if (page.kind === "analysis" && (!page.sourcePageId || !page.valueField)) throw new Error("自定义模块分析页面需要来源记录页面和数值字段。");
  }
  const prefix = `module_${createHash("sha256").update(moduleId).digest("hex").slice(0, 12)}_`;
  const pageIds = new Map(validated.map((page) => {
    if (page.id.startsWith(prefix)) return [page.id, page.id];
    const local = page.id.length <= 64 - prefix.length ? page.id : `${page.id.slice(0, 35)}_${createHash("sha256").update(page.id).digest("hex").slice(0, 8)}`;
    return [page.id, `${prefix}${local}`];
  }));
  const canonicalPages = validated.map((page) => ({ ...page, id: pageIds.get(page.id), moduleId, ...(page.sourcePageId ? { sourcePageId: pageIds.get(page.sourcePageId) } : {}) }));
  schemaUnique(canonicalPages.map((page) => page.id), "页面");
  const implied = canonicalPages.flatMap((page) => page.kind === "analysis" ? ["statistics", "charts"] : [page.kind === "notes" ? "notes" : "records"]);
  return { id: moduleId, title, description: schemaString(input.description ?? "", "模块描述", 20000).trim(), group, color: color.toLowerCase(), icon: "custom", pages: canonicalPages,
    capabilities: [...new Set([...validateResearchCapabilities(input.capabilities), ...implied])] };
}

/** Builtins cannot be replaced, while portable definitions take precedence. */
export function mergeResearchModuleCatalog(...customCatalogs) {
  const catalog = new Map(RESEARCH_MODULES.map((module) => [module.id, structuredClone(module)]));
  for (const entries of customCatalogs) for (const entry of entries ?? []) {
    if (RESEARCH_MODULE_IDS.includes(entry?.id)) continue;
    const module = validateResearchModule(entry); catalog.set(module.id, module);
  }
  return [...catalog.values()];
}

/** Compose page definitions only. Removing a module never deletes stored records or assets. */
export function composeModuleDefinition(base, moduleIds, customCatalog = []) {
  if (!base || typeof base !== "object" || Array.isArray(base)) throw new Error("平台配置必须是对象。");
  if (!Array.isArray(moduleIds) || moduleIds.length > 100) throw new Error("模块必须是数组且最多 100 项。");
  if (new Set(moduleIds).size !== moduleIds.length) throw new Error("模块编号不能重复。");
  const draft = structuredClone(base), selected = new Set(moduleIds), previous = draft.pages ?? [];
  const portable = new Map((draft.customModules ?? []).map((module) => {
    const existing = previous.filter((page) => page.moduleId === module.id);
    const validated = validateResearchModule(existing.length ? { ...module, pages: existing } : module);
    return [validated.id, validated];
  }));
  const catalog = mergeResearchModuleCatalog(customCatalog, [...portable.values()]);
  for (const moduleId of moduleIds) if (!catalog.some((module) => module.id === moduleId)) throw new Error("未知科研模块。");
  draft.modules = [...moduleIds];
  draft.pages = previous.filter((page) => !page.moduleId);
  for (const moduleId of moduleIds) {
    const module = catalog.find((entry) => entry.id === moduleId);
    if (!RESEARCH_MODULE_IDS.includes(moduleId)) portable.set(moduleId, module);
    const existing = previous.filter((page) => page.moduleId === moduleId);
    for (const page of existing.length ? existing : structuredClone(module.pages)) {
      if (draft.pages.some((other) => other.id === page.id)) throw new Error("模块页面与现有页面编号冲突。");
      draft.pages.push(page);
    }
  }
  if (portable.size || Object.hasOwn(base, "customModules")) draft.customModules = [...portable.values()];
  const pages = new Set(draft.pages.map((page) => page.id));
  for (const page of draft.pages) if (page.kind === "analysis" && page.sourcePageId && !pages.has(page.sourcePageId)) {
    for (const key of ["sourcePageId", "valueField", "groupField", "sampleField"]) delete page[key];
  }
  draft.workflows = (draft.workflows ?? []).filter((workflow) => !workflow.sourcePageId || pages.has(workflow.sourcePageId));
  // Existing capabilities may also belong to custom pages; keep those while adding module needs.
  draft.capabilities = [...new Set([...(draft.capabilities ?? []), ...catalog.filter((module) => selected.has(module.id)).flatMap((module) => module.capabilities)])];
  return draft;
}
