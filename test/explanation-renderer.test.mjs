import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
const source = await readFile(new URL("../desktop/renderer/explanations.js", import.meta.url), "utf8");
function fixture() {
  const { window, document } = parseHTML("<html><body><main id='chat'>existing chat</main><section id='help'></section></body></html>");
  let listener, next = 0;
  const api = { explain: vi.fn(async () => {}), cancelExplanation: vi.fn(async () => {}), onExplanation: (fn) => { listener = fn; } };
  vm.runInContext(source, vm.createContext({ window, document, MutationObserver: window.MutationObserver, crypto: { randomUUID: () => `request-${++next}` } }));
  const controller = window.createExplanations(api), host = document.querySelector("#help"), target = { kind: "event", turnId: "turn", eventId: "chosen-event" };
  const panel = window.addDeepExplanation(host, target);
  const sync = (configured = true) => controller.sync({ configured, activeConnectionId: "deepseek", connections: [{ id: "deepseek", name: "我的 DeepSeek", provider: "deepseek", model: "saved-model" }] });
  return { api, host, panel, sync, target, $: (selector) => document.querySelector(selector), emit: (e) => listener({ requestId: `request-${next}`, ...e }) };
}
describe("深入讲解界面", () => {
  it("requires a configured connection, starts only after a click, and sends identifiers only", async () => {
    const f = fixture(); f.sync(false);
    expect(f.$(".deep-start").disabled).toBe(true); expect(f.$(".deep-note").textContent).toContain("设置"); expect(f.api.explain).not.toHaveBeenCalled();
    f.sync(); expect(f.$(".deep-start").disabled).toBe(false); expect(f.$(".deep-note").textContent).toContain("DeepSeek");
    f.$(".deep-start").click(); expect(f.api.explain).toHaveBeenCalledWith("request-1", f.target);
    f.emit({ type: "text", text: "模型增量解释" }); expect(f.$(".deep-output").textContent).toBe("模型增量解释");
    f.emit({ type: "done", text: "完整讲解", cached: false }); expect(f.$(".deep-status").textContent).toContain("未写入聊天"); expect(f.$("#chat").textContent).toBe("existing chat");
  });
  it("reports cache, explicit errors and cancellation, ignores foreign events, and enables retry", async () => {
    const f = fixture(); f.sync(); f.$(".deep-start").click();
    f.emit({ requestId: "foreign", type: "done", text: "wrong", cached: true }); expect(f.$(".deep-output").textContent).toBe("");
    f.emit({ type: "done", text: "cached", cached: true }); expect(f.$(".deep-status").textContent).toContain("没有调用模型");
    f.$(".deep-start").click(); f.emit({ type: "error", message: "connection failed" }); expect(f.$(".deep-status").textContent).toContain("connection failed"); expect(f.$(".deep-start").disabled).toBe(false);
    f.$(".deep-start").click(); f.$(".deep-cancel").click(); expect(f.api.cancelExplanation).toHaveBeenCalledWith("request-3");
    f.emit({ type: "cancelled" }); expect(f.$(".deep-status").textContent).toContain("已取消"); expect(f.$(".deep-cancel").hidden).toBe(true);
  });
  it("cancels a running explanation when its source card is removed", async () => {
    const f = fixture(); f.sync(); f.$(".deep-start").click(); f.panel.remove();
    await vi.waitFor(() => expect(f.api.cancelExplanation).toHaveBeenCalledWith("request-1"));
  });
});
