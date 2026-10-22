import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { URL } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES, ALL_CAPABILITIES, toggleCapability } from "../src/core/capabilities.ts";

const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../desktop/renderer/capabilities.js", import.meta.url), "utf8");
const knowledge = await readFile(new URL("../desktop/renderer/knowledge.cjs", import.meta.url), "utf8");
function fixture() {
  const { window, document } = parseHTML(html);
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }
  let state = { capabilities: ["core"], capabilityRegistry: CAPABILITIES, capabilityOnboarding: true, capabilityUsage: {}, edition: "standard" };
  let trace, usage;
  const api = {
    setCapability: vi.fn(async (id, enabled) => ({ capabilities: toggleCapability(state.capabilities, id, enabled), capabilityOnboarding: false })),
    chooseCapabilities: vi.fn(async (choice) => ({ capabilities: choice === "all" ? ALL_CAPABILITIES : ["core"], capabilityOnboarding: false })),
    onCapabilityUsage: (listener) => { usage = listener; }, onXray: (listener) => { trace = listener; }, send: vi.fn(),
  };
  const context = vm.createContext({ window, document }); vm.runInContext(knowledge, context); vm.runInContext(source, context);
  const onExample = vi.fn();
  const panel = window.createCapabilities(api, { onChange: (patch) => { state = { ...state, ...patch }; panel.sync(state); }, onExample });
  panel.sync(state);
  const $ = (selector) => document.querySelector(selector);
  const toggle = (id, checked) => { const input = $(`[data-capability="${id}"] input`); input.checked = checked; input.dispatchEvent(new window.Event("change")); };
  return { $, panel, api, onExample, toggle, trace: (e) => trace(e), usage: (e) => usage(e), state: () => state, document };
}

describe("能力面板", () => {
  it("offers minimal onboarding and renders all nine switches, five exclusive descriptions and shared knowledge", async () => {
    const f = fixture(); f.panel.guide();
    expect(f.$("#capability-onboarding").open).toBe(true);
    f.$("#capability-choose-minimal").click();
    await vi.waitFor(() => expect(f.$("#capability-onboarding").open).toBe(false));
    expect(f.state().capabilities).toEqual(["core"]);
    expect(f.document.querySelectorAll(".capability-card input:not(:disabled)")).toHaveLength(9);
    expect(f.document.querySelectorAll(".capability-exclusive")).toHaveLength(5);
    expect(f.document.querySelectorAll(".capability-card p b")).toHaveLength(30);
    expect(f.$('[data-capability="core"] input').disabled).toBe(true);
    f.panel.guide(); expect(f.$("#capability-onboarding").open).toBe(false);
  });
  it("updates dependencies and examples without starting a conversation", async () => {
    const f = fixture(); f.$("#my-agent").click(); f.toggle("workflow", true);
    await vi.waitFor(() => expect(f.$("#capability-status").textContent).toContain("一并打开"));
    expect(f.$('[data-capability="subagents"] input').checked).toBe(true);
    expect(f.$("#capability-chip").textContent).toContain("2/9");
    f.toggle("subagents", false);
    await vi.waitFor(() => expect(f.$("#capability-status").textContent).toContain("一并关闭"));
    expect(f.$('[data-capability="workflow"] input').checked).toBe(false);
    f.$('[data-capability="skills"] button').click();
    expect(f.$("#capabilities-dialog").open).toBe(false);
    expect(f.onExample).toHaveBeenCalledWith(expect.stringContaining("Skill"));
    expect(f.api.send).not.toHaveBeenCalled();
    f.usage({ skills: 3 }); expect(f.$('[data-capability="skills"] small').textContent).toContain("3 次");
  });
  it("keeps the persisted state after save errors and explains how overflow is resolved next turn", async () => {
    const f = fixture(); f.api.setCapability.mockRejectedValueOnce(new Error("disk full")); f.toggle("skills", true);
    await vi.waitFor(() => expect(f.$("#capability-status").textContent).toBe("disk full"));
    expect(f.$('[data-capability="skills"] input').checked).toBe(false);
    f.trace({ type: "event", event: { type: "context.overflow" } });
    expect(f.$("#capability-overflow").textContent).toContain("要打开它吗");
    f.$("#capability-overflow button").click();
    await vi.waitFor(() => expect(f.$("#capability-overflow").textContent).toContain("下次发送时生效"));
    expect(f.state().capabilities).toContain("compaction");
    expect(f.api.send).not.toHaveBeenCalled();
  });
});
