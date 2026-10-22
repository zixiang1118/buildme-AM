/** Shared validation for portable research pages; configurations never run code. */
export const PLATFORM_CAPABILITIES = ["records", "files", "statistics", "charts", "notes", "literature", "chemistry", "simulation"];
const FIELD_TYPES = new Set(["text", "number", "date", "select", "longtext"]);
const PAGE_KINDS = new Set(["records", "analysis", "notes"]);
const BAD_IDS = new Set(["__proto__", "prototype", "constructor"]);
export const schemaObject = (value, label) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象。`); return value; };
export const schemaArray = (value, label, max = 10000) => { if (!Array.isArray(value) || value.length > max) throw new Error(`${label}必须是数组且最多 ${max} 项。`); return value; };
export const schemaString = (value, label, max = 10000) => { if (typeof value !== "string" || value.length > max) throw new Error(`${label}必须是文本且长度不超过 ${max}。`); return value; };
export const schemaId = (value, label) => { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(value) || BAD_IDS.has(value)) throw new Error(`${label}编号无效。`); return value; };
export const schemaUnique = (values, label) => { if (new Set(values).size !== values.length) throw new Error(`${label}编号不能重复。`); };

export function assertResearchJson(input, ancestors = new Set()) {
  if (input === null || typeof input === "string" || typeof input === "boolean") return;
  if (typeof input === "number" && Number.isFinite(input)) return;
  if (!input || typeof input !== "object" || ancestors.has(input)) throw new Error("模块必须是有限、无循环的 JSON 数据。");
  if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("模块必须是普通 JSON 对象。");
  ancestors.add(input);
  try { for (const [key, value] of Object.entries(input)) { if (BAD_IDS.has(key)) throw new Error("模块包含不安全的属性名称。"); if (value === undefined && !Array.isArray(input)) continue; assertResearchJson(value, ancestors); } }
  finally { ancestors.delete(input); }
}

export function validateResearchCapabilities(input) {
  const capabilities = schemaArray(input ?? [], "能力", 50).map((entry) => {
    if (!PLATFORM_CAPABILITIES.includes(entry)) throw new Error(`未知能力：${entry}。`);
    return entry;
  });
  schemaUnique(capabilities, "能力"); return capabilities;
}

export function validateResearchPages(input, { moduleIds, selectedModuleIds, max = 100 } = {}) {
  const pages = schemaArray(input ?? [], "页面", max).map((page) => {
    schemaObject(page, "页面");
    if (!PAGE_KINDS.has(page.kind)) throw new Error("页面类型无效。");
    const result = { id: schemaId(page.id, "页面"), title: schemaString(page.title, "页面名称", 200), kind: page.kind };
    if (!result.title.trim()) throw new Error("页面名称不能为空。");
    if (page.moduleId !== undefined) {
      result.moduleId = schemaId(page.moduleId, "模块");
      if (!moduleIds?.includes(result.moduleId)) throw new Error("页面引用的科研模块不存在。");
      if (selectedModuleIds && !selectedModuleIds.includes(result.moduleId)) throw new Error("页面引用的科研模块尚未选择。");
    }
    if (page.kind === "records" || page.kind === "notes") {
      result.fields = schemaArray(page.fields ?? (page.kind === "notes" ? [{ id: "title", label: "标题", type: "text" }, { id: "body", label: "内容", type: "longtext" }] : []), "字段", 200).map((field) => {
        schemaObject(field, "字段");
        if (!FIELD_TYPES.has(field.type)) throw new Error("字段类型无效。");
        const entry = { id: schemaId(field.id, "字段"), label: schemaString(field.label, "字段名称", 200), type: field.type };
        if (!entry.label.trim()) throw new Error("字段名称不能为空。");
        if (field.required !== undefined) { if (typeof field.required !== "boolean") throw new Error("必填属性必须是布尔值。"); entry.required = field.required; }
        if (field.unit !== undefined) entry.unit = schemaString(field.unit, "单位", 100);
        if (field.type === "select") { entry.options = schemaArray(field.options ?? [], "选项", 200).map((option) => schemaString(option, "选项", 300)); schemaUnique(entry.options, "选项"); }
        return entry;
      });
      schemaUnique(result.fields.map((field) => field.id), "字段");
    } else if (page.fields?.length) throw new Error("只有记录和笔记页面可以定义字段。");
    if (page.kind === "analysis") {
      for (const key of ["sourcePageId", "valueField", "groupField", "sampleField"]) if (page[key]) result[key] = schemaId(page[key], "分析引用");
      if (!result.sourcePageId && (result.valueField || result.groupField || result.sampleField)) throw new Error("分析字段需要指定来源页面。");
    }
    return result;
  });
  schemaUnique(pages.map((page) => page.id), "页面");
  for (const page of pages.filter((entry) => entry.kind === "analysis")) {
    if (!page.sourcePageId) continue;
    const source = pages.find((entry) => entry.id === page.sourcePageId && entry.kind === "records");
    if (!source) throw new Error("分析页面必须引用当前配置中的记录页面。");
    for (const key of ["valueField", "groupField", "sampleField"]) if (page[key] && !source.fields.some((field) => field.id === page[key])) throw new Error("分析引用的字段不存在。");
    if (page.valueField && source.fields.find((field) => field.id === page.valueField).type !== "number") throw new Error("分析数值字段必须是数字类型。");
  }
  return pages;
}
