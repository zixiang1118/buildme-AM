import { describe, expect, it, vi } from "vitest";
import { generateResearchModule } from "../desktop/platform-module-ai.mjs";

const moduleDraft = () => ({
  title: "我的样本随访", description: "记录随访时间与检测结果。", group: "自定义", color: "#649b78",
  pages: [{ id: "followup", title: "随访记录", kind: "records", fields: [
    { id: "sample_id", label: "样本编号", type: "text", required: true },
    { id: "date", label: "随访日期", type: "date" },
    { id: "group", label: "分组", type: "select", options: ["A", "B"] },
    { id: "value", label: "指标值", type: "number", unit: "mg/L" },
  ] }], capabilities: ["records", "files"],
});
const success = (output = { module: moduleDraft(), explanation: "用一张记录表保存样本及随访读数。" }) => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(output) }] });
function fixture(response = success()) {
  const model = { provider: "configured-provider", id: "configured-model" };
  const result = vi.fn(async () => response);
  const stream = vi.fn(() => ({ result }));
  const connection = vi.fn(async () => ({ connection: { provider: model.provider, model: model.id, apiKey: "fixture-secret" }, resolved: { model, stream } }));
  return { connection, stream, model, result };
}

describe("one-shot custom module generation", () => {
  it("uses the configured provider once and returns a validated, unsaved editable module", async () => {
    const original = moduleDraft(), f = fixture(success({ module: original, explanation: "  随访记录设计。  " }));
    const generated = await generateResearchModule({ requirement: "  跟踪不同样本的随访时间和检测数值。  ", title: "随访" }, f);
    expect(generated.module).toMatchObject({ title: original.title, description: original.description, group: "自定义", icon: "custom", color: "#649b78" });
    expect(generated.module.id).toMatch(/^custom_[a-f0-9]{32}$/u);
    expect(generated.module.pages[0]).toMatchObject({ kind: "records", moduleId: generated.module.id, fields: original.pages[0].fields });
    expect(generated.explanation).toBe("随访记录设计。");
    expect(original.pages[0].id).toBe("followup");
    expect(f.connection).toHaveBeenCalledTimes(1);
    expect(f.stream).toHaveBeenCalledTimes(1);
    expect(f.result).toHaveBeenCalledTimes(1);
    const [model, context, options] = f.stream.mock.calls[0];
    expect(model).toBe(f.model);
    expect(context.tools).toEqual([]);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("user");
    expect(JSON.parse(context.messages[0].content[0].text)).toEqual({ requirement: "跟踪不同样本的随访时间和检测数值。", title: "随访" });
    expect(context.systemPrompt).toContain("禁止生成 JavaScript");
    expect(context.systemPrompt).not.toContain("fixture-secret");
    expect(options.maxTokens).toBe(5000);
    expect(options.signal).toBeInstanceOf(globalThis.AbortSignal);
    expect(Object.hasOwn(context, "sessionId")).toBe(false);
  });

  it("accepts a whole JSON fence and preserves records, notes and valid analysis references", async () => {
    const module = moduleDraft();
    module.pages.push({ id: "notes", title: "观察笔记", kind: "notes", fields: [{ id: "body", label: "观察结果", type: "longtext" }] });
    module.pages.push({ id: "results", title: "分组分析", kind: "analysis", sourcePageId: "followup", valueField: "value", groupField: "group", sampleField: "sample_id" });
    const response = { stopReason: "stop", content: [{ type: "thinking", thinking: "不应显示内部思考" }, { type: "text", text: "```json\n" + JSON.stringify({ module }) + "\n```" }] };
    const generated = await generateResearchModule({ requirement: "我想保存观察笔记，并按分组分析随访数值。" }, fixture(response));
    const source = generated.module.pages.find((page) => page.kind === "records"), analysis = generated.module.pages.find((page) => page.kind === "analysis");
    expect(analysis.sourcePageId).toBe(source.id);
    expect(analysis.valueField).toBe("value");
    expect(generated.module.capabilities).toEqual(expect.arrayContaining(["records", "notes", "statistics", "charts"]));
    expect(generated.explanation).toBeUndefined();
    expect(JSON.stringify(generated)).not.toContain("不应显示内部思考");
  });

  it("keeps repeated generations isolated from previous module drafts", async () => {
    const f = fixture();
    const first = await generateResearchModule({ requirement: "样本模块" }, f);
    first.module.title = "只在本次预览中修改";
    const second = await generateResearchModule({ requirement: "另一个样本模块" }, f);
    expect(second.module.title).toBe("我的样本随访");
    expect(second.module.id).not.toBe(first.module.id);
    expect(f.stream).toHaveBeenCalledTimes(2);
    expect(f.stream.mock.calls[1][1].messages).toHaveLength(1);
    expect(JSON.stringify(f.stream.mock.calls[1][1])).not.toContain("只在本次预览中修改");
  });

  it("requires meaningful bounded user input before any provider call", async () => {
    const f = fixture();
    for (const input of [undefined, [], {}, { requirement: " " }, { requirement: 123 }, { requirement: "a".repeat(8001) }, { requirement: "样本", title: "a".repeat(201) }]) {
      await expect(generateResearchModule(input, f)).rejects.toThrow(/需求|名称/u);
    }
    expect(f.connection).not.toHaveBeenCalled();
    expect(f.stream).not.toHaveBeenCalled();
  });

  it("reports an actionable error when no model connection is available", async () => {
    await expect(generateResearchModule({ requirement: "样本模块" }, { connection: async () => null })).rejects.toThrow("设置中添加并选择模型连接");
    await expect(generateResearchModule({ requirement: "样本模块" })).rejects.toThrow("设置中添加并选择模型连接");
  });

  it("does not expose provider credentials or raw network errors", async () => {
    const f = fixture();
    f.stream.mockImplementation(() => { throw new Error("apiKey fixture-secret rejected at https://private-endpoint"); });
    await expect(generateResearchModule({ requirement: "样本模块" }, f)).rejects.toThrow("AI 生成模块失败");
    await expect(generateResearchModule({ requirement: "样本模块" }, { connection: async () => { throw new Error("fixture-secret"); } })).rejects.toThrow("无法连接所选模型");
  });

  it.each(["error", "aborted", "length", "toolUse"])("rejects an incomplete provider result (%s) without a fabricated draft", async (stopReason) => {
    const f = fixture({ ...success(), stopReason, errorMessage: "fixture-secret" });
    await expect(generateResearchModule({ requirement: "样本模块" }, f)).rejects.toThrow(stopReason === "length" ? "长度上限" : "未成功完成");
  });

  it("rejects empty text and tool-call output", async () => {
    await expect(generateResearchModule({ requirement: "样本模块" }, fixture({ stopReason: "stop", content: [{ type: "text", text: " " }] }))).rejects.toThrow("没有返回模块草案");
    await expect(generateResearchModule({ requirement: "样本模块" }, fixture({ ...success(), content: [...success().content, { type: "toolCall", name: "write_file", arguments: {} }] }))).rejects.toThrow("未成功完成");
  });

  it.each([
    "不是 JSON",
    "这是你的模块：" + JSON.stringify({ module: moduleDraft() }),
    JSON.stringify(moduleDraft()),
    JSON.stringify({ module: { ...moduleDraft(), script: "execute()" } }),
    JSON.stringify({ module: { ...moduleDraft(), capabilities: ["simulation"] } }),
    JSON.stringify({ module: { ...moduleDraft(), pages: [{ id: "unsafe", title: "脚本", kind: "code", fields: [] }] } }),
    JSON.stringify({ module: { ...moduleDraft(), pages: [{ id: "unsafe", title: "无效字段", kind: "records", fields: "field" }] } }),
    JSON.stringify({ module: { ...moduleDraft(), pages: [{ id: "unsafe", title: "脚本字段", kind: "records", fields: [{ id: "name", label: "名称", type: "text", onChange: "execute()" }] }] } }),
    JSON.stringify({ module: { ...moduleDraft(), pages: [{ id: "analysis", title: "无效分析", kind: "analysis", sourcePageId: "missing", valueField: "value" }] } }),
    JSON.stringify({ module: moduleDraft(), explanation: "a".repeat(2001) }),
  ])("rejects invalid or unsupported JSON instead of pretending generation succeeded", async (text) => {
    await expect(generateResearchModule({ requirement: "样本模块" }, fixture({ stopReason: "stop", content: [{ type: "text", text }] }))).rejects.toThrow("格式不符合要求");
  });

  it("bounds output size", async () => {
    await expect(generateResearchModule({ requirement: "样本模块" }, { ...fixture(), maxOutputChars: 10 })).rejects.toThrow("草案过长");
  });

  it("ends a stalled provider request at the deadline and aborts its signal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.result.mockImplementation(() => new Promise(() => {}));
    try {
      const pending = generateResearchModule({ requirement: "样本模块" }, { ...f, timeoutMs: 50 });
      const rejection = expect(pending).rejects.toThrow("生成模块超时");
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(f.stream.mock.calls[0][2].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
