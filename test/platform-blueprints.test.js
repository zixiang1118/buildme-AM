import { describe, expect, it } from "vitest";
import { generatePlatformPreview, templates } from "../desktop/platform-blueprints.mjs";
import { validatePlatformDefinition } from "../desktop/platform-store.mjs";

describe("editable local research platform blueprints", () => {
  it("offers distinct optional templates without preselecting a biomedical discipline", () => {
    expect(templates.map((template) => template.id)).toEqual(["blank", "environment", "materials", "computation"]);
    for (const template of templates) expect(validatePlatformDefinition(template.definition)).toEqual(template.definition);
    const draft = generatePlatformPreview();
    expect(draft.mode).toBe("local");
    expect(draft.definition.pages).toHaveLength(1);
    expect(draft.definition.pages[0].fields.map((field) => field.label)).toEqual(["记录名称", "备注"]);
    expect(JSON.stringify(draft)).not.toMatch(/阿尔兹|药物|分子|合成方案|论文/u);
    expect(draft.explanation).toContain("本地规则");
  });
  it("makes the user's explicit fields real schema fields and binds analysis to them", () => {
    const draft = generatePlatformPreview({ template: "materials", requirement: "平台名称：吸附实验台。字段：样品编号、制备批次、吸附容量（mg/g）、温度（数字）、备注。需要分组统计和绘图，论文先不要。" });
    expect(draft.definition.name).toBe("吸附实验台");
    const page = draft.definition.pages[0];
    expect(page.fields.map((field) => field.label)).toEqual(["样品编号", "制备批次", "吸附容量", "温度", "备注"]);
    expect(page.fields[3].type).toBe("number");
    expect(page.fields[2]).toMatchObject({ type: "number", unit: "mg/g" });
    const analysis = draft.definition.pages.find((page) => page.kind === "analysis");
    expect(analysis.sourcePageId).toBe(page.id);
    expect(analysis.valueField).toBe(page.fields[2].id);
    expect(analysis.groupField).toBe(page.fields[1].id);
    expect(analysis.sampleField).toBe(page.fields[0].id);
    expect(draft.definition.pages.some((page) => page.id === "writing")).toBe(false);
    expect(draft.definition.pages.flatMap((page) => page.fields ?? []).some((field) => field.id === "property")).toBe(false);
  });
  it("keeps existing field IDs while adding custom fields and removes unwanted analysis", () => {
    const original = JSON.parse(JSON.stringify(templates[1].definition));
    const draft = generatePlatformPreview({ definition: original, requirement: "字段：设备编号、批次。分析暂不要，只登记记录。" });
    expect(draft.definition.pages[0].fields[0]).toEqual(original.pages[0].fields[0]);
    expect(draft.definition.pages[0].fields.some((field) => field.label === "设备编号")).toBe(true);
    expect(new Set(draft.definition.pages[0].fields.map((field) => field.id)).size).toBe(draft.definition.pages[0].fields.length);
    expect(draft.definition.pages.some((page) => page.kind === "analysis")).toBe(false);
    expect(draft.definition.capabilities).not.toContain("statistics");
    expect(original.pages.some((page) => page.kind === "analysis")).toBe(true);
  });
  it("labels domain capabilities as guidance and warns about missing numeric analysis fields", () => {
    const draft = generatePlatformPreview({ requirement: "需要文献、化学和仿真能力，统计和绘图。字段：名称、备注。" });
    expect(draft.definition.capabilities).toEqual(expect.arrayContaining(["literature", "chemistry", "simulation", "statistics", "charts"]));
    expect(draft.warnings).toEqual(expect.arrayContaining([expect.stringContaining("数字字段"), expect.stringContaining("Agent 指导")]));
    expect(() => generatePlatformPreview({ template: "invented" })).toThrow("模板");
    expect(() => generatePlatformPreview({ requirement: { command: "run" } })).toThrow("文本");
  });
});
