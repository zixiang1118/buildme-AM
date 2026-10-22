import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCompareService } from "../desktop/compare.mjs";
import vm from "node:vm";
import { URL } from "node:url";
import { parseHTML } from "linkedom";

describe("同模型读取策略对照", () => {
  it("previews the selected model, task and reference budget before any comparison is created or sent", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const source = await readFile(new URL("../desktop/renderer/compare.js", import.meta.url), "utf8");
    const { window, document } = parseHTML(html);
    Object.defineProperty(window.HTMLSelectElement.prototype, "value", { configurable: true, get() { return this._selectedValue || ""; }, set(value) { this._selectedValue = value; } });
    const panel = document.querySelector("#compare-dialog");
    const group = { id: "comparison", kind: "reading", sides: { left: { engine: "pi", connection: { model: "test" } }, right: { engine: "pi", connection: { model: "test" } } }, workspace: { source: "/current-workspace", excluded: [], expired: false, readOnly: false }, rounds: [], differences: {} };
    const api = {
      state: vi.fn(async () => ({ workspace: { path: "/current-workspace" }, activeConnectionId: "other", connections: [{ id: "other", provider: "local", model: "another" }, { id: "matching", provider: "local", model: "test" }] })),
      compareList: vi.fn(async () => []), compareCreate: vi.fn(async () => group), compareSend: vi.fn(async () => {}),
      compareGet: vi.fn(async () => ({ group, traces: {}, metrics: {}, differences: {}, strategies: { left: "直接读", right: "搜索后再读" } })), onCompare: vi.fn(),
    };
    const context = vm.createContext({ window, document, performance: { now: () => 0 }, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn() });
    vm.runInContext(await readFile(new URL("../desktop/renderer/streaming.js", import.meta.url), "utf8"), context);
    vm.runInContext(source, context);
    const comparison = window.createComparisons(api, { onTurn: vi.fn() });
    await comparison.openReading({ id: "root", model: { provider: "local", id: "test" }, userPrompt: "修复我的页面" }, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 });
    expect(panel.hidden).toBe(false);
    expect(panel.parentElement.classList.contains("workspace")).toBe(true);
    expect(document.querySelector("#compare-kind").value).toBe("reading");
    expect(document.querySelector("#compare-left-connection").value).toBe("matching");
    expect(document.querySelector("#compare-prompt").value).toBe("修复我的页面");
    expect(document.querySelector("#compare-reading-note").textContent).toContain("170 tokens 量级");
    expect(document.querySelector("#compare-reading-note").textContent).toContain("不恢复原回合");
    expect(api.compareCreate).not.toHaveBeenCalled(); expect(api.compareSend).not.toHaveBeenCalled();
    document.querySelector("#compare-create").click();
    await vi.waitFor(() => expect(panel.dataset.busy).toBe("false"));
    expect(document.querySelector("#compare-new-form").hidden).toBe(true);
    expect(api.compareCreate).toHaveBeenCalledWith({ kind: "reading", leftConnectionId: "matching", rightConnectionId: "other", piAll: false });
    expect(api.compareSend).not.toHaveBeenCalled();
    document.querySelector("#compare-send-form").onsubmit({ preventDefault() {} });
    await vi.waitFor(() => expect(api.compareSend).toHaveBeenCalledWith("comparison", "修复我的页面"));
  });

  it("prepares without model calls, then runs different strategies with identical capabilities in independent copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "buildme-reading-")), workspace = join(root, "source");
    await mkdir(workspace); await writeFile(join(workspace, "note.txt"), "original");
    const received = [];
    const agents = { create: async ({ sessionId }) => ({ dispose: async () => {}, agent: { send: async (prompt, options) => {
      received.push({ sessionId, prompt, options });
      await writeFile(join(options.workspacePath, "note.txt"), prompt.includes("files_search") ? "searched" : "read");
      return { text: "completed" };
    } } }) };
    const services = { agents, sessions: { exists: async () => false } };
    const comparison = createCompareService({ root: join(root, "compare"), applicationRoot: root,
      config: async () => ({ workspacePath: workspace, capabilities: ["core"], activeConnectionId: "local", connections: [{ id: "local", provider: "local", model: "test" }] }),
      keyFor: () => undefined, runtime: async () => ({ ctx: { on: () => () => {} } }), service: (_app, name) => services[name],
      traceStore: () => ({ flush: async () => {}, turn: async () => undefined }), onTrace: vi.fn(), approval: vi.fn(), notify: vi.fn(), learning: vi.fn(),
    });
    try {
      const group = await comparison.create({ kind: "reading", leftConnectionId: "local" });
      expect(received).toEqual([]);
      expect(group.sides.left.connection).toEqual(group.sides.right.connection);
      expect(group.sides.left.capabilities).toEqual(["core", "search"]);
      await comparison.coordinator.send(group.id, "整理 note.txt"); await comparison.coordinator.settle(group.id);
      expect(received).toHaveLength(2);
      expect(new Set(received.map((item) => item.sessionId)).size).toBe(2);
      expect(received[0].options.capabilities).toEqual(received[1].options.capabilities);
      expect(received.map((item) => item.prompt).some((prompt) => prompt.includes("先直接读取"))).toBe(true);
      expect(received.map((item) => item.prompt).some((prompt) => prompt.includes("先使用 files_search"))).toBe(true);
      expect(received.every((item) => item.prompt.startsWith("整理 note.txt"))).toBe(true);
      expect(received.every((item) => item.options.permissionMode === "bypass")).toBe(true);
      expect(received.every((item) => item.options.comparePolicy.workspaceRoot === item.options.workspacePath && item.options.comparePolicy.readOnly === false)).toBe(true);
      expect(new Set(received.map((item) => item.options.workspacePath)).size).toBe(2);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("original");
      const details = await comparison.details(group.id);
      expect(details.strategies.right).toContain("files_search");
      expect(details.group.rounds[0].runs.left.status).toBe("done");
      expect(details.group.differences.left.changes[0].path).toBe("note.txt");
    } finally { await comparison.close(); await rm(root, { recursive: true, force: true }); }
  });
});
