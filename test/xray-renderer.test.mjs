import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { URL } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { tokenLedger } from "../src/core/trace-ledger.ts";
import { traceMoment } from "../src/core/trace.ts";

const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../desktop/renderer/xray.js", import.meta.url), "utf8");
const inspectSource = await readFile(new URL("../desktop/renderer/xray-inspect.js", import.meta.url), "utf8");
const ledgerSource = await readFile(new URL("../desktop/renderer/xray-ledger.js", import.meta.url), "utf8");
const knowledgeSource = await readFile(new URL("../desktop/renderer/knowledge.cjs", import.meta.url), "utf8");
const helpSource = await readFile(new URL("../desktop/renderer/xray-help.js", import.meta.url), "utf8");
const at = "2026-10-05T00:00:00.000Z";
let eventIndex = 0;
const event = (type, values = {}) => ({ id: `${type}-${++eventIndex}`, type, at, ...values });
function turn(id = "one", values = {}) {
  return { id, sessionId: "session", engine: "pi", turnIndex: 1, startedAt: at, status: "done", userPrompt: "检查项目", model: { provider: "faux", id: "local" }, fidelity: { usage: "exact", approvals: true, promptSegments: true }, promptSegments: [], events: [], usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }, ...values };
}
function fixture(records = [], prefs = {}) {
  const { window, document } = parseHTML(html);
  // linkedom does not implement select.value writes or layout/focus.
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", { configurable: true, get() { return this._selectedValue || ""; }, set(value) { this._selectedValue = value; } });
  const storage = new Map(Object.entries(prefs));
  const media = { matches: false, addEventListener: vi.fn() };
  window.matchMedia = () => media;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  let listener, callback;
  const api = {
    onXray: vi.fn((fn) => { listener = fn; }),
    xrayTurns: vi.fn(async (sessionId) => records.filter((item) => item.sessionId === sessionId).map((item) => ({ ...item, moment: traceMoment(item) }))),
    xrayTurn: vi.fn(async (id) => globalThis.structuredClone(records.find((item) => item.id === id))),
    xrayLedger: vi.fn(async (id) => tokenLedger(records.find((item) => item.id === id), async (childId) => records.find((item) => item.id === childId))),
    writeClipboardText: vi.fn(async () => undefined),
    xrayPromptSource: vi.fn(async () => ({ path: "/project/guide.md", readOnly: false })),
  };
  const context = vm.createContext({ window, document, structuredClone: globalThis.structuredClone, localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) }, requestAnimationFrame: (fn) => { callback = fn; return 1; } });
  vm.runInContext(knowledgeSource, context);
  vm.runInContext(helpSource, context);
  vm.runInContext(inspectSource, context);
  vm.runInContext(ledgerSource, context);
  vm.runInContext(source, context);
  const onExperiment = vi.fn();
  const xray = window.createXray(api, { onExperiment });
  const flush = () => { const next = callback; callback = undefined; next?.(); };
  const $ = (selector) => document.querySelector(selector);
  const dispatch = (node, type) => node.dispatchEvent(new window.Event(type));
  const open = () => { $("#xray-toggle").click(); flush(); };
  return { window, document, api, xray, $, flush, storage, media, dispatch, open, onExperiment, emit: (notification) => listener(globalThis.structuredClone(notification)) };
}

describe("X 光 renderer", () => {
  it("labels partial usage and exposes provider reasoning separately from the answer", async () => {
    const current = turn("partial", { status: "aborted", fidelity: { usage: "partial" }, usage: { modelCalls: 2, toolCalls: 0, durationMs: 10, inputTokens: 10, outputTokens: 2, reportedCalls: 1, missingCalls: 1 }, events: [
      { ...event("llm.request", { round: 1, messageCount: 1, toolNames: [] }), context: { total: 2 } },
      event("llm.response", { round: 1, durationMs: 10, textPreview: "answer", toolCalls: [], reasoning: "模型返回的思考", usage: { input: 10, output: 2 } }),
    ] });
    const f = fixture([current]); await f.xray.setSession("session", "standard"); await f.xray.openTurn(current); f.flush();
    expect(f.$('.xray-metrics').textContent).toContain("已记录 12 tokens（1/2 次，部分用量）");
    expect(f.$('.xray-timeline')?.textContent || f.$('#xray-timeline').textContent).toContain("模型返回的思考");
  });
  it("keeps answer stats separate from streamed text and attaches the correct historical turn", async () => {
    const current = turn("two", { turnIndex: 2, usage: { modelCalls: 2, toolCalls: 3, inputTokens: 1200, outputTokens: 20, durationMs: 8200 } });
    const f = fixture([current]);
    await f.xray.setSession("session", "standard");
    const old = f.document.createElement("article"), answer = f.document.createElement("article");
    f.$("#messages").append(old, answer);
    f.xray.bindHistory([{ role: "assistant", node: old, turnIndex: 1 }, { role: "assistant", node: answer, turnIndex: 2 }]);
    f.flush();
    expect(f.document.querySelectorAll(".xray-stats")).toHaveLength(1);
    expect(answer.nextSibling.textContent).toContain("2 次模型调用 · 3 个工具 · 1,220 tokens · 8.2 秒");
    answer.textContent = "流式更新后的回答";
    answer.nextSibling.click(); f.flush();
    expect(f.$("#xray-turn").value).toBe("two");
    expect(f.$(".xray-metrics").textContent).toContain("1,220 tokens");
    expect(f.$(".xray-hint")).toBeNull();
    expect(f.storage.get("buildme.xray.hint")).toBe("seen");
  });

  it("batches live events and preserves expanded arguments while approval and results arrive", async () => {
    const f = fixture();
    await f.xray.setSession(undefined, "standard");
    const answer = f.document.createElement("article");
    f.$("#messages").append(answer); f.xray.beginRun(answer); f.open();
    f.emit({ type: "turn-start", turn: turn("live", { status: "running" }) });
    const call = event("tool.call", { toolCallId: "a", round: 1, name: "read", args: { file: "<img src=x onerror=alert(1)>" }, parallelGroup: "g" });
    f.emit({ type: "event", turnId: "live", event: call }); f.flush();
    const args = f.$(".xray-detail"); args.open = true;
    f.emit({ type: "event", turnId: "live", event: event("tool.approval", { toolCallId: "a", decision: "user-deny", permissionMode: "ask", reason: "用户拒绝" }) });
    f.emit({ type: "event", turnId: "live", event: event("tool.result", { toolCallId: "a", durationMs: 80, isError: true, resultPreview: "denied", resultBytes: 6, truncated: false, result: "denied" }) });
    f.flush();
    expect(f.$(".xray-detail")).toBe(args); expect(args.open).toBe(true);
    expect(f.$(".xray-parallel").textContent).toContain("并行执行");
    expect(f.$(".xray-error").textContent).toContain("你拒绝了 · 每次询问");
    expect(f.$(".xray-error").textContent).toContain("0.1 秒");
    expect(f.$("#xray-timeline img")).toBeNull();
    expect(f.$(".xray-stats").textContent).toContain("1 个工具");
  });

  it("loads a child timeline by its own id and does not mix child usage into the parent", async () => {
    const child = turn("child", { sessionId: "child-session", parentTurnId: "root", usage: { modelCalls: 4, toolCalls: 0, inputTokens: 100, outputTokens: 5, durationMs: 500 } });
    const root = turn("root", { events: [event("subagent.start", { childTurnId: "child", kind: "delegate_task", task: "阅读源代码" })] });
    const f = fixture([root, child]); await f.xray.setSession("session", "standard"); f.open();
    expect(f.api.xrayTurn).not.toHaveBeenCalledWith("child");
    const tree = f.$(".xray-child-tree"); tree.open = true; f.dispatch(tree, "toggle");
    await vi.waitFor(() => expect(f.$(".xray-child-stats")).not.toBeNull()); f.flush();
    expect(f.api.xrayTurn).toHaveBeenCalledWith("child");
    expect(f.$(".xray-child-stats").textContent).toContain("4 次模型调用");
    expect(f.$(".xray-metrics").textContent).toContain("0模型调用");
    f.emit({ type: "turn-end", turn: { ...child, status: "error" } }); f.flush();
    expect(f.$(".xray-child-tree")).toBe(tree);
  });

  it("renders compaction, skills, workflows and errors without inventing missing usage", async () => {
    const f = fixture([turn("one", { fidelity: { usage: "none", promptSegments: false }, events: [
      event("context.compacted", { tokensBefore: 10000, coveredMessages: 20, summaryPreview: "summary" }),
      event("context.clipped", { charsBefore: 2000, charsAfter: 100 }),
      event("skill.load", { name: "guide", chars: 20, builtin: false, path: "/workspace/guide" }),
      event("workflow.step", { stepIndex: 1, title: "读取", status: "error" }),
      event("error", { message: "连接中断" }),
    ] })]);
    await f.xray.setSession("session", "standard"); f.open();
    expect(f.$("#xray-timeline").textContent).toContain("压缩后用量未提供");
    expect(f.$("#xray-timeline").textContent).toContain("加载 Skill · guide");
    expect(f.$("#xray-timeline").textContent).toContain("工作流第 1 步 · 失败");
    expect(f.$("#xray-timeline").textContent).toContain("连接中断");
    expect(f.$(".xray-metrics").textContent).toContain("tokens 未提供");
  });

  it("ignores stale session queries and foreign notifications", async () => {
    const f = fixture(); let finish;
    f.api.xrayTurns.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const previous = f.xray.setSession("previous", "standard");
    await f.xray.setSession("next", "standard");
    finish([turn("old", { sessionId: "previous" })]); await previous;
    f.emit({ type: "turn-start", turn: turn("foreign", { sessionId: "previous" }) });
    f.open();
    expect(f.$("#xray-turn").disabled).toBe(true);
    expect(f.api.xrayTurn).not.toHaveBeenCalled();
    expect(f.$("#xray-timeline").textContent).toContain("暂无 X 光记录");
  });

  it("keeps the chosen old turn pinned until following latest is requested", async () => {
    const first = turn("first"), next = turn("next", { turnIndex: 2 });
    const f = fixture([first, next]); await f.xray.setSession("session", "standard"); f.open();
    f.$("#xray-turn").value = "first"; f.dispatch(f.$("#xray-turn"), "change"); await Promise.resolve(); f.flush();
    f.emit({ type: "turn-start", turn: turn("newest", { turnIndex: 3, status: "running" }) }); f.flush();
    expect(f.$("#xray-turn").value).toBe("first");
    f.$("#xray-follow").click(); f.flush();
    expect(f.$("#xray-turn").value).toBe("newest");
  });

  it("persists open state and reading mode, and makes the chat inert in overlay mode", () => {
    const f = fixture([], { "buildme.xray.open": "true", "buildme.xray.mode": "advanced" });
    f.flush(); expect(f.$("#xray-panel").hidden).toBe(false);
    expect(f.$("#xray-panel").dataset.mode).toBe("advanced");
    f.media.matches = true; f.media.addEventListener.mock.calls[0][1]();
    expect(f.$(".workspace").inert).toBe(true);
    expect(f.$("#xray-panel").getAttribute("aria-modal")).toBe("true");
    f.$("#xray-close").click();
    expect(f.$(".workspace").inert).toBe(false);
    expect(f.storage.get("buildme.xray.open")).toBe("false");
  });

  it("reports query failure and unsupported DSH explicitly", async () => {
    const f = fixture(); f.api.xrayTurns.mockRejectedValueOnce(new Error("disk failure"));
    await f.xray.setSession("session", "standard"); f.open();
    expect(f.$("#xray-timeline").textContent).toContain("disk failure");
    await f.xray.setSession(undefined, "full"); f.flush();
    expect(f.$("#xray-timeline").textContent).toContain("完全体引擎尚未接入");
  });
});

const segment = (name, text, estTokens = 10, extra = {}) => ({ name, text, estTokens, chars: text.length, source: "base", ...extra });
const request = (round, data = {}) => event("llm.request", { round, messageCount: 1, toolNames: [], context: { systemPrompt: 20, toolDefinitions: 20, userMessages: 20, assistantMessages: 20, toolResults: 10, summary: 0, total: 90, limit: 100 }, ...data });
const showTab = (f, tab) => { f.$(`#xray-tab-${tab}`).click(); f.flush(); };

describe("X 光本地讲解", () => {
  it("opens locally without API calls or history changes, and Escape closes only the explanation", async () => {
    const f = fixture([turn("one", { events: [request(1)] })]);
    await f.xray.setSession("session", "standard"); f.open();
    for (const method of Object.values(f.api)) method.mockClear();
    const before = f.$("#messages").innerHTML;
    const button = f.$('.xray-model .xray-help-toggle');
    button.click();
    const body = f.$('.xray-model .xray-help-card');
    expect(body.hidden).toBe(false);
    expect(body.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(body.querySelectorAll("h4")).toHaveLength(3);
    expect(body.textContent).toContain("本地讲解 · 不消耗 token");
    expect(f.document.getElementById(button.getAttribute("aria-controls"))).toBe(body);
    for (const method of Object.values(f.api)) expect(method).not.toHaveBeenCalled();
    expect(f.$("#messages").innerHTML).toBe(before);
    expect(f.$("#xray-turn").children).toHaveLength(1);
    const focus = vi.spyOn(button, "focus");
    const escape = new f.window.Event("keydown", { bubbles: true, cancelable: true });
    escape.key = "Escape"; button.dispatchEvent(escape);
    expect(body.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(focus).toHaveBeenCalledOnce();
    expect(f.$("#xray-panel").hidden).toBe(false);
    button.click();
    expect(body.querySelectorAll("h4")).toHaveLength(3);
    body.querySelector("button").click();
    expect(body.hidden).toBe(true);
  });

  it("preserves an open explanation while live approval and result events arrive", async () => {
    const f = fixture([turn("live", { status: "running", events: [event("tool.call", { name: "read", toolCallId: "a", args: {}, parallelGroup: 1 })] })]);
    await f.xray.setSession("session", "standard"); f.open();
    const help = f.$('.xray-tool [data-topic="tool.call"]');
    help.querySelector("button").click();
    f.emit({ type: "event", turnId: "live", event: event("tool.approval", { toolCallId: "a", decision: "auto-allow", permissionMode: "workspace-write" }) });
    f.emit({ type: "event", turnId: "live", event: event("tool.result", { toolCallId: "a", durationMs: 10, isError: false, resultPreview: "done", resultBytes: 4 }) });
    f.flush();
    expect(f.$('.xray-tool [data-topic="tool.call"]')).toBe(help);
    expect(help.querySelector(".xray-help-card").hidden).toBe(false);
    for (const topic of ["tool.approval", "tool.result", "parallel"]) {
      const card = f.$(`[data-topic="${topic}"]`);
      card.querySelector("button").click();
      expect(card.querySelector(".xray-help-card").hidden).toBe(false);
    }
    showTab(f, "context"); showTab(f, "timeline");
    expect(help.querySelector(".xray-help-card").hidden).toBe(false);
    await f.xray.setSession(undefined, "standard"); f.flush();
    expect(help.isConnected).toBe(false);
  });

  it("explains each prompt segment, known capability and context bar, including compaction", async () => {
    const f = fixture([turn("one", {
      promptSegments: [segment("web", "fetch", 10, { source: "capability", capabilityId: "web" }), segment("unknown", "custom", 10, { capabilityId: "constructor" })],
      events: [request(1), event("context.compacted", { tokensBefore: 90, coveredMessages: 2, summaryPreview: "summary" }), request(2)],
    })]);
    await f.xray.setSession("session", "standard"); f.open(); showTab(f, "prompt");
    const segmentHelp = [...f.document.querySelectorAll('.xray-segment [data-topic="prompt.segment"]')];
    expect(segmentHelp).toHaveLength(2);
    for (const help of segmentHelp) help.querySelector("button").click();
    expect(segmentHelp[0].textContent).toContain("读网页");
    expect(segmentHelp[0].textContent).toContain("WebFetch");
    expect(segmentHelp[1].textContent).not.toContain("undefined");
    expect(segmentHelp[1].textContent).toContain("提示词段落");
    showTab(f, "context");
    const charts = [...f.document.querySelectorAll('.xray-context-call [data-topic="context.usage"]')];
    expect(charts).toHaveLength(2);
    charts[0].querySelector("button").click();
    expect(charts[0].textContent).toContain("累计多次调用");
    const compact = f.$('.xray-context-compaction .xray-help');
    compact.querySelector("button").click();
    expect(compact.textContent).toContain("遗漏细节");
  });

  it("offers an explanation for skills, workflows, child agents, clipping, overflow and errors", async () => {
    const events = [
      event("skill.catalog", { skills: [] }), event("skill.load", { name: "guide", chars: 10, builtin: false }),
      event("workflow.step", { stepIndex: 1, title: "read", status: "start" }),
      event("subagent.start", { childTurnId: "child", task: "read" }),
      event("context.clipped", { charsBefore: 200, charsAfter: 50 }),
      event("context.overflow", { estTokens: 200, limit: 100 }), event("error", { message: "provider failed" }),
    ];
    const f = fixture([turn("one", { events })]); await f.xray.setSession("session", "standard"); f.open();
    for (const event of events) {
      const help = f.$(`[data-event-id="${event.id}"] > .xray-help`);
      help.querySelector("button").click();
      expect(help.querySelectorAll("h4")).toHaveLength(3);
      expect(help.textContent).not.toContain("undefined");
    }
  });

  it("renders knowledge as text rather than executable markup", () => {
    const f = fixture();
    f.window.XrayKnowledge.topics.error.what = '<img src=x onerror="attack()">';
    const help = f.window.XrayHelp("error"); help.querySelector("button").click();
    expect(help.textContent).toContain('<img src=x onerror="attack()">');
    expect(help.querySelector("img")).toBeNull();
  });
});

describe("X 光 inspection tabs", () => {
  it("compares adjacent prompts, excludes removed segments from proportions, and copies the exact snapshot", async () => {
    const first = turn("old", { promptSegments: [segment("base", "old"), segment("removed", "gone")] });
    const second = turn("next", { turnIndex: 2, promptSegments: [segment("base", "new"), segment("a", "A"), segment("b", "B")] });
    const f = fixture([first, second]); await f.xray.setSession("session", "standard"); f.open(); showTab(f, "prompt");
    await vi.waitFor(() => expect(f.$(".xray-diff-status").textContent).toContain("新增 2 · 修改 1 · 移除 1"));
    const shares = [...f.document.querySelectorAll(".xray-proportion .xray-swatch")].map((item) => Number.parseFloat(item.style.width));
    expect(shares.reduce((sum, value) => sum + Math.round(value * 10), 0)).toBe(1000);
    expect(f.$('[data-change="removed"]').textContent).toContain("removed");
    f.$("#xray-prompt .xray-small-action").click();
    expect(f.api.writeClipboardText).toHaveBeenCalledWith("new\n\nA\n\nB");
  });

  it("does not call a non-adjacent record the previous turn or mark missing evidence as additions", async () => {
    const f = fixture([turn("old"), turn("third", { turnIndex: 3, promptSegments: [segment("base", "text")] })]);
    await f.xray.setSession("session", "standard"); f.open(); showTab(f, "prompt");
    await vi.waitFor(() => expect(f.$(".xray-diff-status").textContent).toContain("上一回合记录缺失"));
    expect(f.$("[data-change]")).toBeNull();
  });

  it("keeps an old prompt comparison response out of the newly selected session", async () => {
    const f = fixture([turn("before"), turn("current", { turnIndex: 2, promptSegments: [segment("current", "yes")] }), turn("foreign", { sessionId: "other", promptSegments: [segment("different", "text")] })]);
    await f.xray.setSession("session", "standard");
    let finish;
    f.api.xrayTurn.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.open(); showTab(f, "prompt");
    await f.xray.setSession("other", "standard"); f.flush();
    finish(turn("before", { promptSegments: [segment("obsolete", "must stay detached")] }));
    await Promise.resolve(); await Promise.resolve(); f.flush();
    expect(f.$("#xray-prompt").textContent).toContain("different");
    expect(f.$("#xray-prompt").textContent).not.toContain("obsolete");
  });

  it("provides read-only bundled source paths, opens editable sources by turn/index, and reports failures", async () => {
    const f = fixture([turn("one", { promptSegments: [segment("bundle", "a", 1, { sourcePath: "bundles/base/test.md" }), segment("project", "b", 1, { sourcePath: "/project/guide.md" })] })]);
    f.api.xrayPromptSource.mockResolvedValueOnce({ path: "/app/bundles/base/test.md", readOnly: true });
    await f.xray.setSession("session", "standard"); f.open(); showTab(f, "prompt");
    await vi.waitFor(() => expect(f.$('[data-segment-name="project"]').textContent).toContain("打开源文件"));
    expect(f.$('[data-segment-name="bundle"]').textContent).not.toContain("打开源文件");
    const buttons = [...f.$('[data-segment-name="project"]').querySelectorAll("button")];
    const open = buttons.find((item) => item.textContent === "打开源文件");
    f.api.xrayPromptSource.mockRejectedValueOnce(new Error("file missing")); open.click();
    await vi.waitFor(() => expect(f.$('[data-segment-name="project"]').textContent).toContain("file missing"));
    expect(f.api.xrayPromptSource).toHaveBeenLastCalledWith("one", 1, true);
  });

  it("renders context limits and compaction without inventing an unknown after count", async () => {
    const before = request(1), after = request(2, { context: { ...before.context, userMessages: 0, assistantMessages: 0, toolResults: 0, total: 40 } });
    const f = fixture([turn("one", { events: [before, event("context.compacted", { tokensBefore: 90, coveredMessages: 5, summaryPreview: "kept" }), after] })]);
    await f.xray.setSession("session", "standard"); f.open(); showTab(f, "context");
    expect(f.document.querySelectorAll(".xray-context-call")).toHaveLength(2);
    expect(f.document.querySelectorAll(".xray-context-warning")).toHaveLength(1);
    expect(f.$(".xray-context-warning").textContent).toContain("90.0%");
    expect(f.$(".xray-context-compaction").textContent).toContain("压缩后用量未提供");
    expect([...f.$(".xray-context-calls").children].map((item) => item.className)).toEqual(["xray-context-call xray-context-warning", "xray-context-compaction", "xray-context-call"]);
    expect(f.$(".xray-context-bar").getAttribute("aria-label")).toContain("工具结果 10");
  });

  it("only shows raw in advanced mode, switches calls, copies JSON and never treats markup as HTML", async () => {
    const payload = { format: "pi-context", context: { text: "<img src=x onerror=alert(1)>", apiKey: "«已隐藏»" } };
    const f = fixture([turn("one", { fidelity: { rawRequest: true, usage: "exact" }, events: [request(1, { raw: payload }), request(2, { raw: { preview: "saved" }, rawTruncated: true }), event("llm.response", { round: 1, durationMs: 5, textPreview: "done", toolCalls: [], usage: { input: 12, output: 3 } })] })]);
    await f.xray.setSession("session", "standard"); f.open();
    expect(f.$("#xray-tab-raw").hidden).toBe(true);
    f.$("#xray-advanced").click(); showTab(f, "raw");
    const tree = f.$(".xray-json-node"); f.dispatch(tree, "toggle");
    const context = tree.querySelector(".xray-json-node"); context.open = true; f.dispatch(context, "toggle");
    expect(f.$("#xray-raw img")).toBeNull();
    expect(f.$(".xray-raw-usage").textContent).toContain("输入 12 · 输出 3 · 缓存读取 未提供");
    f.$("#xray-raw .xray-small-action").click();
    expect(JSON.parse(f.api.writeClipboardText.mock.calls[0][0])).toEqual(payload);
    const select = f.$(".xray-raw-select"); select.value = select.children[1].value; f.dispatch(select, "change");
    expect(f.$("#xray-raw").textContent).toContain("记录已截断");
    f.$("#xray-beginner").click(); f.flush();
    expect(f.$("#xray-tab-timeline").getAttribute("aria-selected")).toBe("true");
    expect(f.$("#xray-raw").hidden).toBe(true);
  });

  it("updates live raw usage without collapsing the tree, and reflects final retention pruning", async () => {
    const f = fixture(); await f.xray.setSession("session", "standard"); f.open();
    const item = request(1, { raw: { value: 1 } });
    f.emit({ type: "turn-start", turn: turn("live", { status: "running", fidelity: { rawRequest: true }, events: [item] }) });
    f.$("#xray-advanced").click(); showTab(f, "raw");
    const tree = f.$(".xray-json-node");
    f.emit({ type: "event", turnId: "live", event: event("llm.response", { round: 1, usage: { input: 8, output: 2, cacheRead: 0 } }) }); f.flush();
    expect(f.$(".xray-json-node")).toBe(tree);
    expect(f.$(".xray-raw-usage").textContent).toContain("缓存读取 0");
    f.emit({ type: "turn-end", turn: turn("live", { fidelity: { rawRequest: true }, events: [{ ...item, raw: undefined, rawTruncated: true }] }) }); f.flush();
    expect(f.$("#xray-raw").textContent).toContain("容量限制已省略");
    expect(f.$(".xray-json-node")).toBeNull();
  });

  it("distinguishes unsupported raw, disabled recording and expired historical bodies", async () => {
    const f = fixture([turn("one", { fidelity: { rawRequest: false } }), turn("expired", { sessionId: "expired", fidelity: { rawRequest: true }, events: [request(1)] }), turn("dsh", { engine: "dsh", sessionId: "dsh", fidelity: { rawRequest: false } })]);
    await f.xray.setSession("session", "standard"); f.open(); f.$("#xray-advanced").click(); showTab(f, "raw");
    expect(f.$("#xray-raw").textContent).toContain("未开启原始请求记录");
    await f.xray.setSession("expired", "standard"); f.flush();
    expect(f.$("#xray-raw").textContent).toContain("历史保留范围");
    await f.xray.setSession("dsh", "full"); f.flush();
    expect(f.$("#xray-raw").textContent).toContain("完全体引擎没有提供这项数据");
  });
});

describe("Large and empty inspection records", () => {
  it("expands large JSON collections in batches and copies the full stored payload", async () => {
    const payload = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [`key${index}`, index]));
    const f = fixture([turn("one", { fidelity: { rawRequest: true }, events: [request(1, { raw: payload })] })]);
    await f.xray.setSession("session", "standard"); f.open(); f.$("#xray-advanced").click(); showTab(f, "raw");
    const tree = f.$(".xray-json-node");
    expect(tree.querySelectorAll(".xray-json-leaf")).toHaveLength(0);
    f.dispatch(tree, "toggle");
    expect(tree.querySelectorAll(".xray-json-leaf")).toHaveLength(100);
    tree.querySelector("button").click();
    expect(tree.querySelectorAll(".xray-json-leaf")).toHaveLength(200);
    tree.querySelector("button").click();
    expect(tree.querySelectorAll(".xray-json-leaf")).toHaveLength(205);
    expect(tree.querySelector("button")).toBeNull();
    f.$("#xray-raw .xray-small-action").click();
    expect(JSON.parse(f.api.writeClipboardText.mock.calls[0][0])).toEqual(payload);
  });

  it("handles empty prompts and unavailable context capacity without invalid percentages", async () => {
    const f = fixture([turn("one", { events: [request(1, { context: { systemPrompt: 0, toolDefinitions: 0, userMessages: 0, assistantMessages: 0, toolResults: 0, summary: 0, total: 0, limit: 0 } })] })]);
    await f.xray.setSession("session", "standard"); f.open(); showTab(f, "prompt");
    expect(f.$("#xray-prompt").textContent).toContain("没有系统提示词段落");
    showTab(f, "context");
    expect(f.$("#xray-context").textContent).toContain("上限未知");
    expect(f.$("#xray-context").innerHTML).not.toMatch(/NaN|Infinity/);
  });
});

describe("发现卡与 Token 账单", () => {
  it("exposes the ledger through the preload actually loaded by Electron", async () => {
    const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
    const preload = main.match(/preload: join\(here, "([^"]+)"\)/)[1];
    const source = await readFile(new URL(`../desktop/${preload}`, import.meta.url), "utf8");
    const invoke = vi.fn();
    let api;
    vm.runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke } }) });
    api.xrayLedger("real-turn");
    expect(invoke).toHaveBeenCalledWith("desktop:xray-ledger", "real-turn");
  });

  it("attaches only one discovery card to the final answer when restoring a multi-call turn", async () => {
    const compact = event("context.compacted", { tokensBefore: 100, coveredMessages: 3, summaryPreview: "kept" });
    const f = fixture([turn("history", { events: [compact] })]);
    await f.xray.setSession("session", "standard");
    const nodes = Array.from({ length: 3 }, () => f.document.createElement("article"));
    f.$("#messages").append(...nodes);
    f.xray.bindHistory(nodes.map((node) => ({ role: "assistant", node, turnIndex: 1 })));
    f.flush();
    expect(f.document.querySelectorAll(".xray-moment")).toHaveLength(1);
    expect(f.document.querySelectorAll(".xray-stats")).toHaveLength(1);
    expect(nodes[2].nextSibling.className).toBe("xray-stats");
    expect(nodes[0].nextSibling).toBe(nodes[1]);
  });

  it("shows one local card after completion, opens the exact event, and persists dismissal", async () => {
    const compact = event("context.compacted", { tokensBefore: 100, coveredMessages: 3, summaryPreview: "kept" });
    const trace = turn("moment", { events: [compact], moment: { title: "你的对话在这里被压缩了", description: "看看摘要", eventIds: [compact.id] } });
    const f = fixture([trace]); await f.xray.setSession("session", "standard");
    const answer = f.document.createElement("article"); f.$("#messages").append(answer);
    f.xray.bindHistory([{ role: "assistant", node: answer, turnIndex: 1 }]); f.flush();
    expect(f.document.querySelectorAll(".xray-moment")).toHaveLength(1);
    expect(f.api.xrayLedger).not.toHaveBeenCalled();
    f.$(".xray-moment-open").click(); await Promise.resolve(); await Promise.resolve(); f.flush();
    expect(f.$(".xray-event-focused").dataset.eventId).toBe(compact.id);
    expect(f.$("#xray-tab-timeline").getAttribute("aria-selected")).toBe("true");
    f.$(".xray-moment-dismiss").click(); f.flush();
    expect(f.$(".xray-moment")).toBeNull();
    expect(f.storage.get("buildme.xray.dismissed.moment")).toBe("true");
  });

  it("does not show a card while running or when the preference is off", async () => {
    const f = fixture([], { "buildme.xray.moments": "false" }); await f.xray.setSession(undefined, "standard");
    const answer = f.document.createElement("article"); f.$("#messages").append(answer); f.xray.beginRun(answer);
    const trace = turn("live", { status: "running", events: [event("skill.load", { name: "guide", chars: 5, builtin: false })] });
    f.emit({ type: "turn-start", turn: trace }); f.flush();
    expect(f.$(".xray-answer-insights").hidden).toBe(true);
    trace.status = "done"; trace.moment = traceMoment(trace);
    f.emit({ type: "turn-end", turn: trace }); f.flush();
    expect(f.$(".xray-moment")).toBeNull();
    f.$("#show-xray-moments").checked = true; f.dispatch(f.$("#show-xray-moments"), "change"); f.flush();
    expect(f.$(".xray-moment-open").textContent).toContain("guide");
    f.$("#show-xray-moments").checked = false; f.dispatch(f.$("#show-xray-moments"), "change"); f.flush();
    expect(f.$(".xray-moment")).toBeNull();
  });

  it("renders reported caches separately, marks historical gaps, and opens an experiment without running one", async () => {
    const trace = turn("bill", { fidelity: { usage: "exact", subagents: true }, events: [request(1), event("llm.response", { round: 1, durationMs: 10, textPreview: "done", toolCalls: [], usage: { input: 20, output: 3, cacheRead: 50, cacheWrite: 7 } })] });
    const f = fixture([trace]); await f.xray.setSession("session", "standard"); f.open(); showTab(f, "ledger");
    await vi.waitFor(() => expect(f.$(".ledger-call")).not.toBeNull());
    expect(f.$(".ledger-call summary").textContent).toContain("实测 77");
    expect([...f.$(".ledger-section").querySelectorAll("dd")].map((item) => item.textContent)).toEqual(["20", "3", "50", "7"]);
    expect(f.$("#xray-ledger").textContent).toContain("历史没有逐条占用数据");
    expect(f.onExperiment).not.toHaveBeenCalled();
    f.$(".ledger-experiment button").click();
    expect(f.onExperiment).toHaveBeenCalledWith(expect.objectContaining({ id: "bill" }), { inputTokens: 20, outputTokens: 3, cacheReadTokens: 50, cacheWriteTokens: 7 });
    expect(f.$("#xray-panel").hidden).toBe(true);
  });

  it("shows ledger failures explicitly and refreshes on demand", async () => {
    const f = fixture([turn()]); await f.xray.setSession("session", "standard");
    f.api.xrayLedger.mockRejectedValueOnce(new Error("read failed"));
    f.open(); showTab(f, "ledger");
    await vi.waitFor(() => expect(f.$(".ledger-status").textContent).toContain("read failed"));
    f.$("#xray-ledger > button").click();
    await vi.waitFor(() => expect(f.$(".ledger-section")).not.toBeNull());
    expect(f.api.xrayLedger).toHaveBeenCalledTimes(2);
    expect(f.$("#xray-ledger").textContent).not.toMatch(/NaN|Infinity|undefined/);
  });
});
