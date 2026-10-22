import console from "node:console";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import vm from "node:vm";
import MarkdownIt from "markdown-it";
import { parseHTML } from "linkedom";

import { describe, expect, it, vi } from "vitest";

class FakeClassList {
  values = new Set();
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
}

class FakeElement {
  attributes = new Map();
  children = [];
  classList = new FakeClassList();
  dataset = {};
  disabled = false;
  hidden = false;
  listeners = new Map();
  open = false;
  scrollHeight = 28;
  clientHeight = 100;
  bounds = { left: 600, right: 710, top: 620, bottom: 652, width: 110, height: 32 };
  scrollTop = 0;
  style = {};
  textContent = "";
  title = "";
  type = "";
  value = "";
  #className = "";

  set className(value) {
    this.#className = value;
    this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() { return this.#className; }
  set innerHTML(value) { this.fragment = parseHTML(`<div>${value}</div>`).document.firstChild; this.textContent = this.fragment.textContent; }
  get innerHTML() { return this.fragment.innerHTML; }
  querySelector(selector) { return this.fragment.querySelector(selector); }

  addEventListener(name, listener) { this.listeners.set(name, listener); }
  getBoundingClientRect() { return this.bounds; }
  append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); this.scrollHeight = Math.max(28, this.children.length * 20); }
  before(child) { child.parentNode = this.parentNode; this.parentNode.children.splice(this.parentNode.children.indexOf(this), 0, child); }
  close() { this.open = false; }
  click() { return this.listeners.get("click")?.({ preventDefault() {} }); }
  contains(target) { return target === this || this.children.some((child) => child.contains?.(target)); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  replaceChildren(...children) { this.children = [...children]; this.scrollHeight = Math.max(28, this.children.length * 20); }
  requestSubmit() { return this.listeners.get("submit")?.({ preventDefault() {} }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

const selectors = [
  ".composer-dock > .context-bar",
  "#attach-files", "#attachment-list", "#attachment-preview", "#attachment-preview-title", "#attachment-preview-note", "#attachment-preview-content", "#attachment-preview-close",
  "#community-entry", "#platform-entry", "#platform-current-name", "#platform-menu", "#platform-menu-options", "#platform-manage", "#xray-close",
  "#platform-chat-context", "#platform-chat-name", "#platform-chat-modules",
  "#agent-name", "#allow-approval", "#api-key", "#api-key-label", "#paste-api-key", "#approval-arguments", "#approval-dialog", "#approval-tool",
  "#base-url", "#cancel-settings", "#chat-title", "#close-settings", "#close-sidebar", "#composer",
  "#connection-auth-copy", "#connection-auth-hint", "#connection-name", "#connection-profile", "#connection-state", "#delete-connection", "#deny-approval",
  "#header-settings", "#full-edition", "#messages", "#model", "#model-chip", "#model-label", "#model-suggestions",
  "#new-chat", "#new-connection", "#open-sidebar", "#permission-chip", "#permission-label", "#permission-menu", "#plugin-market", "#plugin-market-dialog", "#close-plugin-market",
  "#open-pi-community-popular", "#open-pi-community-github", "#open-pi-community-reddit",
  "#prompt", "#provider", "#refresh-sessions", "#send", "#session-list", "#settings", "#settings-dialog",
  "#record-raw-requests", "#settings-form", "#sidebar-backdrop", "#status", "#workspace-chip",
  "#workspace-label", ".connection-dot",
];

async function rendererFixture(overrides = {}) {
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  const permissionButtons = ["ask", "workspace-write", "bypass"].map((mode) => {
    const element = new FakeElement();
    element.dataset.permission = mode;
    return element;
  });
  const themeButtons = ["system", "light", "dark"].map((mode) => {
    const element = new FakeElement();
    element.dataset.themeOption = mode;
    return element;
  });
  elements.get("#permission-menu").hidden = true;
  elements.get("#permission-menu").bounds = { left: 0, right: 290, top: 0, bottom: 204, width: 290, height: 204 };
  elements.get("#platform-menu").hidden = true;
  elements.get("#platform-menu").append(elements.get("#platform-menu-options"), elements.get("#platform-manage"));
  elements.get("#send").type = "submit";
  elements.get("#send").textContent = "↑";

  let streamListener;
  let approvalListener;
  let completeSend;
  let failSend;
  const initialState = {
    activeConnectionId: "primary",
    catalog: [
      { provider: "openai", label: "OpenAI", models: [{ id: "gpt-5", name: "GPT 5" }] },
      { provider: "anthropic", label: "Anthropic", models: [{ id: "claude-sonnet-4-5" }] },
      { provider: "deepseek", label: "DeepSeek", models: [{ id: "deepseek-chat" }] },
    ],
    configured: true,
    connections: [{ id: "primary", name: "主要模型", provider: "openai", model: "gpt-5", baseUrl: "https://api.openai.com/v1" }],
    name: "BuildMe",
    permissionMode: "ask",
    experienceMode: "original",
    theme: "dark",
    workspace: { path: "/Users/me/Project", name: "Project" },
  };
  const api = {
    chooseAttachments: vi.fn(async () => ({ canceled: true, attachments: [], errors: [] })),
    previewAttachment: vi.fn(async () => ({ name: "file.txt", kind: "document", text: "preview" })),
    abort: vi.fn(async () => true),
    chooseWorkspace: vi.fn(async () => ({ workspace: { path: "/tmp/Next", name: "Next" } })),
    deleteConnection: vi.fn(async () => ({ connections: [], activeConnectionId: null, configured: false })),
    messages: vi.fn(async () => []),
    onApproval: vi.fn((listener) => { approvalListener = listener; return () => undefined; }),
    onStream: vi.fn((listener) => { streamListener = listener; return () => undefined; }),
    openMarket: vi.fn(async () => undefined),
    openFullEdition: vi.fn(async () => ({ reused: false })),
    platformState: vi.fn(async () => ({ platforms: [], snapshot: null })),
    platformSelect: vi.fn(async () => ({ platforms: [], snapshot: null })),
    readClipboardText: vi.fn(async () => "clipboard-key"),
    respondApproval: vi.fn(async () => ({ accepted: true })),
    saveConnection: vi.fn(async (connection) => ({
      activeConnectionId: "saved",
      configured: true,
      connections: [{ ...connection, apiKey: undefined, id: "saved" }],
    })),
    selectConnection: vi.fn(async (id) => ({ activeConnectionId: id })),
    send: vi.fn(() => new Promise((resolve, reject) => { completeSend = resolve; failSend = reject; })),
    sessions: vi.fn(async () => []),
    setPermissionMode: vi.fn(async (permissionMode) => permissionMode),
    setExperienceMode: vi.fn(async (experienceMode) => ({ experienceMode })),
    setTheme: vi.fn(async (theme) => theme),
    state: vi.fn(async () => initialState),
    ...overrides,
  };

  const body = new FakeElement();
  const documentElement = new FakeElement();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    body,
    documentElement,
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    createElement: () => new FakeElement(),
    querySelector: (selector) => elements.get(selector),
    querySelectorAll: (selector) => selector === "[data-permission]" ? permissionButtons : selector === "[data-theme-option]" ? themeButtons : [],
  };
  const media = { matches: true, addEventListener: vi.fn() };
  const xray = { setSession: vi.fn(), bindHistory: vi.fn(), beginRun: vi.fn(), endRun: vi.fn() };
  let platformsVisible = false;
  const platforms = { open: vi.fn(async () => { platformsVisible = true; }), close: vi.fn(() => { platformsVisible = false; }), refresh: vi.fn(async () => undefined), isOpen: vi.fn(() => platformsVisible) };
  let platformsOptions;
  let experienceOptions;
  const experiences = { sync: vi.fn(), closeMenu: vi.fn(), switching: false, createWelcome: () => { const welcome = new FakeElement(); welcome.className = "welcome"; return welcome; }, selectMode: vi.fn(async (mode) => { experienceOptions.onState(await api.setExperienceMode(mode)); experienceOptions.onCommit(); return true; }) };
  let clock = 0, nextTask = 1;
  const frames = new Map(), timers = new Map();
  const advance = (ms = 200) => {
    clock += ms;
    for (const [id, task] of [...timers]) if (task.at <= clock) { timers.delete(id); task.callback(); }
    for (let pass = 0; frames.size && pass < 10; pass++) {
      const pending = [...frames]; frames.clear();
      for (const [, callback] of pending) callback(clock);
    }
  };
  const context = vm.createContext({
    console,
    document,
    Error,
    String,
    performance: { now: () => clock },
    requestAnimationFrame: callback => { const id = nextTask++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { const id = nextTask++; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    window: { innerWidth: 1120, innerHeight: 820, addEventListener: (name, listener) => windowListeners.set(name, listener), matchMedia: vi.fn(() => media), personalAgent: api, createCommunityPanel: () => ({ sync() {}, hide() {} }), createExplanations: () => ({ sync() {} }), createAchievements: () => ({}), createComparisons: () => ({ open() {}, close() {}, isOpen: () => false }), createCapabilities: () => ({ sync() {}, guide() {} }), createXray: () => xray, createPlatforms: vi.fn((_api, options) => { platformsOptions = options; return platforms; }), createExperiences: vi.fn((_api, options) => { experienceOptions = options; return experiences; }) },
  });
  const source = await readFile(new URL("../desktop/renderer/renderer.js", import.meta.url), "utf8");
  context.window.markdownit = MarkdownIt;
  const markdownContext = vm.createContext({ window: context.window, document: parseHTML("<html></html>").document });
  vm.runInContext(await readFile(new URL("../desktop/renderer/markdown.js", import.meta.url), "utf8"), markdownContext);
  const render = context.window.renderMarkdown;
  const renderMarkdown = vi.fn((element, text) => {
    // The surrounding controls are fake; Markdown itself uses a real DOM.
    element.fragment ||= parseHTML("<article></article>").document.firstChild;
    render(element.fragment, text);
    element.classList.add("markdown-body");
    element.textContent = element.fragment.textContent;
  });
  context.window.renderMarkdown = renderMarkdown;
  vm.runInContext(await readFile(new URL("../desktop/renderer/streaming.js", import.meta.url), "utf8"), context);
  vm.runInContext(source, context, { filename: "desktop/renderer/renderer.js" });
  await vi.waitFor(() => expect(api.state).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(api.sessions).toHaveBeenCalledOnce());

  return {
    api,
    advance,
    renderMarkdown,
    xray,
    platforms,
    platformsOptions,
    experiences,
    approvalButtons: { allow: elements.get("#allow-approval"), deny: elements.get("#deny-approval") },
    completeSend: (result) => completeSend(result),
    failSend: (error) => failSend(error),
    document,
    emitDocument: (type, event) => documentListeners.get(type)?.({ preventDefault() {}, ...event }),
    emitWindow: (type, event) => windowListeners.get(type)?.(event),
    window: context.window,
    element: (selector) => elements.get(selector),
    emitApproval: (request) => approvalListener(request),
    emitStream: (event) => streamListener(event),
    permissionButtons,
    themeButtons,
  };
}

function fire(element, type, event = {}) {
  return element.listeners.get(type)?.({ preventDefault() {}, target: element, ...event });
}

describe("chat attachments in the composer", () => {
  const files = [
    { id: "file-a", name: "校准记录.txt", size: 120, kind: "document" },
    { id: "file-b", name: "样本.png", size: 1500, kind: "image", previewDataUrl: "data:image/png;base64,YWJj" },
  ];
  it("adds selected files, previews readable content, and removes an attachment before sending", async () => {
    const fixture = await rendererFixture({ chooseAttachments: vi.fn(async () => ({ attachments: files, errors: [] })), previewAttachment: vi.fn(async () => ({ ...files[0], text: "设备 DEV-42" })) });
    fire(fixture.element("#attach-files"), "click");
    await vi.waitFor(() => expect(fixture.element("#attachment-list").children).toHaveLength(2));
    const list = fixture.element("#attachment-list"); expect(list.hidden).toBe(false);
    fire(list.children[0].children[0], "click");
    await vi.waitFor(() => expect(fixture.element("#attachment-preview-content").children[0]?.textContent).toBe("设备 DEV-42"));
    expect(fixture.element("#attachment-preview").open).toBe(true);
    fire(fixture.element("#attachment-preview-close"), "click");
    expect(fixture.element("#attachment-preview").open).toBe(false);
    fire(list.children[1].children[1], "click");
    expect(list.children).toHaveLength(1);
    expect(list.children[0].dataset.attachmentId).toBe("file-a");
  });

  it("allows a file-only message and sends identities rather than filesystem paths or image bytes", async () => {
    const fixture = await rendererFixture({ chooseAttachments: vi.fn(async () => ({ attachments: files, errors: [] })) });
    fire(fixture.element("#attach-files"), "click");
    await vi.waitFor(() => expect(fixture.element("#attachment-list").children).toHaveLength(2));
    const send = fire(fixture.element("#composer"), "submit");
    expect(fixture.api.send).toHaveBeenCalledExactlyOnceWith({ sessionId: undefined, prompt: "请阅读并分析所附文件。", attachmentIds: ["file-a", "file-b"] });
    expect(fixture.element("#attach-files").disabled).toBe(true);
    expect(fixture.element("#messages").children[0].children[0].className).toBe("message-attachments");
    fixture.completeSend({ sessionId: "uploaded-session", text: "识别完成" }); await send;
    expect(fixture.element("#attachment-list").hidden).toBe(true);
    expect(fixture.element("#attach-files").disabled).toBe(false);
  });

  it("retains the files and original question after a failed send for a retry", async () => {
    const fixture = await rendererFixture({ chooseAttachments: vi.fn(async () => ({ attachments: [files[0]], errors: [] })) });
    fire(fixture.element("#attach-files"), "click");
    await vi.waitFor(() => expect(fixture.element("#attachment-list").children).toHaveLength(1));
    fixture.element("#prompt").value = "检查这份校准记录";
    const failed = fire(fixture.element("#composer"), "submit");
    fixture.failSend(new Error("网络错误")); await failed;
    expect(fixture.element("#prompt").value).toBe("检查这份校准记录");
    expect(fixture.element("#attachment-list").children).toHaveLength(1);
    const retried = fire(fixture.element("#composer"), "submit");
    expect(fixture.api.send).toHaveBeenLastCalledWith({ sessionId: undefined, prompt: "检查这份校准记录", attachmentIds: ["file-a"] });
    fixture.completeSend({ sessionId: "retry-session", text: "done" }); await retried;
  });

  it("reports individual file errors and clears draft files when a new chat starts", async () => {
    const fixture = await rendererFixture({ chooseAttachments: vi.fn(async () => ({ attachments: [files[0]], errors: [{ name: "old.doc", message: "请另存为 docx" }] })) });
    fire(fixture.element("#attach-files"), "click");
    await vi.waitFor(() => expect(fixture.element("#attachment-list").children).toHaveLength(1));
    expect(fixture.element("#status").textContent).toContain("old.doc");
    expect(fixture.element("#status").classList.contains("error")).toBe(true);
    fire(fixture.element("#new-chat"), "click");
    expect(fixture.element("#attachment-list").hidden).toBe(true);
  });

  it("ignores a late file selection response after navigating to a new chat", async () => {
    let resolveFiles;
    const fixture = await rendererFixture({ chooseAttachments: vi.fn(() => new Promise(resolve => { resolveFiles = resolve; })) });
    fire(fixture.element("#attach-files"), "click");
    fire(fixture.element("#new-chat"), "click");
    resolveFiles({ attachments: [files[0]], errors: [] });
    await vi.waitFor(() => expect(fixture.element("#attach-files").disabled).toBe(false));
    expect(fixture.element("#attachment-list").hidden).toBe(true);
  });
});

function researchSelection(id = "a") {
  const platforms = [
    { id: "a", name: "材料测试平台", version: 2 },
    { id: "b", name: "环境监测平台", version: 1 },
  ];
  const selected = platforms.find((platform) => platform.id === id);
  return { platforms, activePlatformId: id, snapshot: selected ? { definition: { ...selected, assistant: { modelConnectionId: "research-model" } }, definitionVersion: selected.version } : null };
}

function researchAppState(id = "a") {
  const selection = researchSelection(id);
  return {
    configured: true, experienceMode: "research", activeConnectionId: "global", theme: "dark",
    platformModelConnectionId: id ? "research-model" : null,
    activeResearchPlatform: id ? selection.platforms.find((platform) => platform.id === id) : null,
    connections: [{ id: "global", model: "日常模型", provider: "openai", configured: true }, { id: "research-model", model: "课题模型", provider: "openai", configured: true }],
  };
}

describe("Desktop renderer", () => {
  it("coalesces a burst of deltas and flushes the final tail before completion", async () => {
    const fixture = await rendererFixture();
    fixture.element("#prompt").value = "长回答";
    const submission = fire(fixture.element("#composer"), "submit");
    const before = fixture.renderMarkdown.mock.calls.length;
    for (let i = 0; i < 1000; i++) fixture.emitStream({ type: "text", sessionId: "long", delta: "内容 " });
    expect(fixture.renderMarkdown).toHaveBeenCalledTimes(before);
    fixture.advance();
    expect(fixture.renderMarkdown).toHaveBeenCalledTimes(before + 1);
    fixture.emitStream({ type: "text", sessionId: "long", delta: "\n\n**最后一段**" });
    fixture.completeSend({ sessionId: "long", text: "unused" }); await submission;
    const answer = fixture.element("#messages").children.at(-1);
    expect(answer.querySelector("strong").textContent).toBe("最后一段");
    expect(answer.textContent.match(/内容/g)).toHaveLength(1000);
    const completed = fixture.renderMarkdown.mock.calls.length;
    fixture.advance();
    expect(fixture.renderMarkdown).toHaveBeenCalledTimes(completed);
  });

  it("keeps a reader's scroll position and resumes following at the bottom", async () => {
    const fixture = await rendererFixture();
    fixture.element("#prompt").value = "长回答";
    const submission = fire(fixture.element("#composer"), "submit");
    const messages = fixture.element("#messages"); messages.scrollHeight = 3000;
    fixture.emitStream({ type: "text", sessionId: "scroll", delta: "第一段" }); fixture.advance();
    expect(messages.scrollTop).toBe(3000);
    messages.scrollTop = 120; fire(messages, "scroll");
    messages.scrollHeight = 6000;
    fixture.emitStream({ type: "text", sessionId: "scroll", delta: "\n\n第二段" }); fixture.advance();
    expect(messages.scrollTop).toBe(120);
    messages.scrollTop = 5900; fire(messages, "scroll");
    messages.scrollHeight = 6600;
    fixture.emitStream({ type: "text", sessionId: "scroll", delta: "\n\n第三段" }); fixture.advance();
    expect(messages.scrollTop).toBe(6600);
    messages.scrollTop = 80; fire(messages, "scroll");
    fixture.emitStream({ type: "text", sessionId: "scroll", delta: "\n\n尾段" });
    fixture.completeSend({ sessionId: "scroll" }); await submission; fixture.advance();
    expect(messages.scrollTop).toBe(80);
  });

  it("flushes in-flight deltas received during the final session refresh", async () => {
    let completeRefresh;
    const sessions = vi.fn(async () => []);
    const fixture = await rendererFixture({ sessions });
    fixture.element("#prompt").value = "继续";
    const submission = fire(fixture.element("#composer"), "submit");
    fixture.emitStream({ type: "reasoning", sessionId: "late", delta: "思考内容" });
    fixture.emitStream({ type: "text", sessionId: "late", delta: "第一段" });
    sessions.mockImplementationOnce(() => new Promise(resolve => { completeRefresh = resolve; }));
    fixture.completeSend({ sessionId: "late" });
    await vi.waitFor(() => expect(sessions).toHaveBeenCalledTimes(2));
    fixture.emitStream({ type: "text", sessionId: "late", delta: "\n\n**最后片段**" });
    completeRefresh([]); await submission;
    expect(fixture.element("#messages").children.at(-1).querySelector("strong").textContent).toBe("最后片段");
    expect(fixture.element("#messages").children.filter(node => node.className === "message-reasoning")).toHaveLength(1);
    const completed = fixture.renderMarkdown.mock.calls.length; fixture.advance();
    expect(fixture.renderMarkdown).toHaveBeenCalledTimes(completed);
  });

  it("flushes batched reasoning and response boundaries on failure, then isolates the next run", async () => {
    const fixture = await rendererFixture();
    fixture.element("#prompt").value = "继续";
    const failed = fire(fixture.element("#composer"), "submit");
    fixture.emitStream({ type: "reasoning", sessionId: "failed", delta: "思考一" });
    fixture.emitStream({ type: "text", sessionId: "failed", delta: "回答一" });
    fixture.emitStream({ type: "response-start", sessionId: "failed" });
    fixture.emitStream({ type: "reasoning", sessionId: "failed", delta: "思考二" });
    fixture.emitStream({ type: "text", sessionId: "failed", delta: "\n\n**回答二**" });
    fixture.failSend(new Error("连接中断")); await failed;
    const answer = fixture.element("#messages").children.at(-1);
    const thought = fixture.element("#messages").children.find(node => node.className === "message-reasoning");
    expect(thought.children[1].textContent).toBe("思考一\n\n思考二");
    expect(answer.querySelector("strong").textContent).toBe("回答二");
    expect(answer.textContent).toContain("连接中断");
    const retried = fire(fixture.element("#composer"), "submit");
    fixture.emitStream({ type: "text", sessionId: "failed", delta: "**新内容**" });
    fixture.completeSend({ sessionId: "failed" }); await retried; fixture.advance();
    expect(fixture.element("#messages").children.at(-1).textContent.trim()).toBe("新内容");
    expect(answer.textContent).toContain("回答一");
  });

  it("renders history and split streamed Markdown, retaining formatting after cancellation", async () => {
    const fixture = await rendererFixture({
      sessions: vi.fn(async () => [{ id: "history", updatedAt: "2026-10-10T00:00:00.000Z", turnCount: 1 }]),
      messages: vi.fn(async () => [{ role: "assistant", text: "## 历史回答\n\n**已完成**" }]),
    });
    await fire(fixture.element("#session-list").children[0], "click");
    expect(fixture.element("#messages").children[0].querySelector("h2").textContent).toBe("历史回答");
    fixture.element("#prompt").value = "继续";
    const submission = fire(fixture.element("#composer"), "submit");
    await vi.waitFor(() => expect(fixture.api.send).toHaveBeenCalled());
    fixture.emitStream({ type: "text", sessionId: "history", delta: "## 新回答\n\n**加" });
    fixture.emitStream({ type: "text", sessionId: "history", delta: "粗**\n\n| 项 | 值 |\n|---|---|\n| 状态 | 好 |" });
    fixture.advance();
    const answer = fixture.element("#messages").children.at(-1);
    expect(answer.querySelector("h2").textContent).toBe("新回答");
    expect(answer.querySelector("strong").textContent).toBe("加粗");
    expect(answer.querySelector("td").textContent).toBe("状态");
    await fire(fixture.element("#send"), "click");
    fixture.failSend(new Error("cancelled")); await submission;
    expect(answer.querySelector("strong").textContent).toBe("加粗");
    expect(answer.textContent).toContain("已取消。");
  });

  it("renders the completed result when no text deltas arrived", async () => {
    const fixture = await rendererFixture(); fixture.element("#prompt").value = "问题";
    const submission = fire(fixture.element("#composer"), "submit");
    fixture.completeSend({ sessionId: "final-only", text: "## 完整结果\n\n**完成**" }); await submission;
    expect(fixture.element("#messages").children.at(-1).querySelector("h2").textContent).toBe("完整结果");
  });

  it("keeps personal branding and exposes the workspace, permission, model, and theme controls", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    expect(html).toContain("BuildMe");
    expect(html).toContain('aria-label="选择 BuildMe 版本"');
    expect(html).toContain('data-mode="original"');
    expect(html).toContain('data-mode="learning"');
    expect(html).toContain('data-mode="research"');
    expect(html).toContain('data-permission="bypass"');
    expect(html).toContain("完全访问（不审批）");
    expect(html).toContain('data-theme-option="light"');
    expect(html).toContain('id="workspace-chip"');
    expect(html).toContain('id="plugin-market"');
    expect(html).toContain("Pi 社区热门插件");
    expect(html).toContain("GitHub 热门");
    expect(html).not.toContain("OpenAI Plugins &amp; Apps");
    expect(html).not.toMatch(/deepseek harness/i);
    expect(html).toContain('src="../assets/buildme-mark.png"');
    expect(html).not.toContain('id="welcome-folder"');
    expect(html).not.toContain('id="welcome-settings"');
    expect(html).not.toMatch(/<img[^>]+src=["']https?:/i);
  });


  it("shows user conversation turns instead of the internal event total", async () => {
    const fixture = await rendererFixture({
      sessions: vi.fn(async () => [{
        id: "three-turns",
        updatedAt: "2026-09-16T00:00:00.000Z",
        health: "healthy",
        eventCount: 83,
        turnCount: 3,
      }]),
    });
    await vi.waitFor(() => expect(fixture.element("#session-list").children).toHaveLength(1));
    const session = fixture.element("#session-list").children[0];
    expect(session.children[2].textContent).toBe("3 轮对话");
    expect(session.children[2].textContent).not.toContain("83");
  });


  it("opens the BuildMe Full edition through the privileged desktop bridge", async () => {
    const fixture = await rendererFixture();
    await fire(fixture.element("#full-edition"), "click");
    expect(fixture.api.openFullEdition).toHaveBeenCalledOnce();
  });

  it("exposes the research entry only after selecting the research version", async () => {
    const fixture = await rendererFixture();
    expect(fixture.element("#platform-entry").hidden).toBe(true);
    fire(fixture.element("#platform-entry"), "click");
    expect(fixture.platforms.open).not.toHaveBeenCalled();
    expect(fixture.api.setExperienceMode).not.toHaveBeenCalled();
    await fixture.experiences.selectMode("learning");
    expect(fixture.element("#platform-entry").hidden).toBe(true);
    await fixture.experiences.selectMode("research");
    expect(fixture.element("#platform-entry").hidden).toBe(false);
    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.api.platformState).toHaveBeenCalledOnce());
    expect(fixture.element("#platform-menu").hidden).toBe(false);
    expect(fixture.platforms.open).not.toHaveBeenCalled();
    fire(fixture.element("#platform-manage"), "click");
    await vi.waitFor(() => expect(fixture.platforms.open).toHaveBeenCalledOnce());
    expect(fixture.element("#chat-title").textContent).toBe("新对话");
    expect(fixture.api.send).not.toHaveBeenCalled();

    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.api.platformState).toHaveBeenCalledTimes(2));
    fire(fixture.element("#platform-manage"), "click");
    await vi.waitFor(() => expect(fixture.platforms.open).toHaveBeenCalledTimes(2));
    expect(fixture.api.setExperienceMode).toHaveBeenCalledTimes(2);
    await fixture.experiences.selectMode("original");
    expect(fixture.element("#platform-entry").hidden).toBe(true);
  });

  it("places platform suggestions in the composer for user review", async () => {
    const fixture = await rendererFixture();
    fixture.platformsOptions.onPrompt("根据我的需求搭建可调整的科研平台。");
    expect(fixture.element("#prompt").value).toBe("根据我的需求搭建可调整的科研平台。");
    expect(fixture.element("#prompt").focused).toBe(true);
    expect(fixture.api.send).not.toHaveBeenCalled();
  });

  it("refreshes the scoped assistant model after selecting another workspace", async () => {
    const fixture = await rendererFixture({
      state: vi.fn(async () => ({ experienceMode: "research", configured: true, activeConnectionId: "global", platformModelConnectionId: "research-model", activeResearchPlatform: { id: "old", name: "原工作区平台", version: 1 }, theme: "dark",
        connections: [{ id: "global", model: "日常模型", provider: "openai", configured: true }, { id: "research-model", model: "原课题模型", provider: "openai", configured: true }] })),
      platformState: vi.fn(async () => ({ platforms: [], snapshot: null })),
    });
    expect(fixture.element("#model-label").textContent).toBe("原课题模型");
    expect(fixture.element("#platform-current-name").textContent).toBe("当前：原工作区平台");
    await fire(fixture.element("#workspace-chip"), "click");
    await vi.waitFor(() => expect(fixture.element("#model-label").textContent).toBe("日常模型"));
    expect(fixture.api.platformState).toHaveBeenCalledOnce();
    expect(fixture.api.selectConnection).not.toHaveBeenCalled();
    expect(fixture.element("#platform-current-name").textContent).toBe("未启用平台");
  });

  it("shows the actual active platform and updates its name after platform changes", async () => {
    const fixture = await rendererFixture({ state: vi.fn(async () => ({ experienceMode: "research", configured: true, theme: "dark", activeResearchPlatform: { id: "a", name: "材料测试平台", version: 2 } })) });
    expect(fixture.element("#platform-current-name").textContent).toBe("当前：材料测试平台");
    expect(fixture.element("#platform-entry").title).toContain("配置 v2");
    expect(fixture.element("#platform-chat-context").hidden).toBe(false);
    expect(fixture.element("#platform-chat-name").textContent).toBe("材料测试平台");
    expect(fixture.element("#prompt").placeholder).toContain("科研助手");
    fixture.platformsOptions.onState({ snapshot: { definition: { id: "b", name: "环境监测平台", assistant: {} }, definitionVersion: 1 } });
    expect(fixture.element("#platform-current-name").textContent).toBe("当前：环境监测平台");
    fixture.platformsOptions.onState({ snapshot: { definition: { id: "b", name: "重新命名的平台", assistant: {} }, definitionVersion: 2 } });
    expect(fixture.element("#platform-current-name").textContent).toBe("当前：重新命名的平台");
    expect(fixture.element("#platform-entry").attributes.get("aria-label")).toContain("重新命名的平台");
    fixture.platformsOptions.onState({ snapshot: null, platforms: [] });
    expect(fixture.element("#platform-current-name").textContent).toBe("未启用平台");
    expect(fixture.element("#platform-chat-context").hidden).toBe(true);
    expect(fixture.element("#prompt").placeholder).toBe("描述任务或提出问题");
  });

  it("disables a platform from the header, restores the global model, and can enable an existing platform", async () => {
    let selectedId = "a";
    const fixture = await rendererFixture({
      state: vi.fn(async () => researchAppState(selectedId)),
      platformState: vi.fn(async () => researchSelection(selectedId)),
      platformSelect: vi.fn(async (id) => { selectedId = id; return researchSelection(id); }),
    });
    expect(fixture.element("#model-label").textContent).toBe("课题模型");
    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.element("#platform-menu-options").children[0].disabled).toBe(false));
    const options = fixture.element("#platform-menu-options").children;
    expect(options[0].children[0].children[0].textContent).toBe("不启用平台");
    expect(options[1].attributes.get("aria-checked")).toBe("true");
    fire(options[0], "click");
    await vi.waitFor(() => expect(fixture.api.platformSelect).toHaveBeenCalledWith(null));
    await vi.waitFor(() => expect(fixture.element("#platform-menu").hidden).toBe(true));
    expect(fixture.element("#platform-current-name").textContent).toBe("未启用平台");
    expect(fixture.element("#model-label").textContent).toBe("日常模型");
    expect(fixture.element("#platform-entry").focused).toBe(true);
    expect(fixture.api.selectConnection).not.toHaveBeenCalled();

    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.api.platformState).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fixture.element("#platform-menu-options").children[0].disabled).toBe(false));
    expect(fixture.element("#platform-menu-options").children[0].attributes.get("aria-checked")).toBe("true");
    fire(fixture.element("#platform-menu-options").children[2], "click");
    await vi.waitFor(() => expect(fixture.element("#platform-current-name").textContent).toBe("当前：环境监测平台"));
    expect(fixture.api.platformSelect).toHaveBeenLastCalledWith("b");
    expect(fixture.element("#model-label").textContent).toBe("课题模型");
    expect(fixture.platforms.open).not.toHaveBeenCalled();
  });

  it("preserves a disabled platform choice when the app restores research state", async () => {
    const fixture = await rendererFixture({
      state: vi.fn(async () => researchAppState(null)),
      platformState: vi.fn(async () => researchSelection(null)),
    });
    expect(fixture.element("#platform-current-name").textContent).toBe("未启用平台");
    expect(fixture.element("#model-label").textContent).toBe("日常模型");
    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.element("#platform-menu-options").children[0].disabled).toBe(false));
    expect(fixture.element("#platform-menu-options").children[0].attributes.get("aria-checked")).toBe("true");
    expect(fixture.api.platformSelect).not.toHaveBeenCalled();
  });

  it("keeps the active platform and model when switching fails and allows retry", async () => {
    const fixture = await rendererFixture({
      state: vi.fn(async () => researchAppState()),
      platformState: vi.fn(async () => researchSelection()),
      platformSelect: vi.fn(async () => { throw new Error("平台保存失败"); }),
    });
    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.element("#platform-menu-options").children[0].disabled).toBe(false));
    fire(fixture.element("#platform-menu-options").children[0], "click");
    await vi.waitFor(() => expect(fixture.element("#status").textContent).toBe("平台保存失败"));
    expect(fixture.element("#platform-current-name").textContent).toBe("当前：材料测试平台");
    expect(fixture.element("#model-label").textContent).toBe("课题模型");
    expect(fixture.element("#platform-menu").hidden).toBe(false);
    expect(fixture.element("#platform-entry").disabled).toBe(false);
    expect(fixture.element("#platform-menu-options").children[0].disabled).toBe(false);
  });

  it("supports keyboard navigation and closes the platform menu with Escape or an outside click", async () => {
    const fixture = await rendererFixture({ state: vi.fn(async () => researchAppState(null)), platformState: vi.fn(async () => researchSelection(null)) });
    fire(fixture.element("#platform-entry"), "keydown", { key: "ArrowDown" });
    await vi.waitFor(() => expect(fixture.element("#platform-menu-options").children[0].disabled).toBe(false));
    const options = fixture.element("#platform-menu-options").children;
    expect(fixture.element("#platform-entry").attributes.get("aria-expanded")).toBe("true");
    expect(options[0].focused).toBe(true);
    fire(fixture.element("#platform-menu"), "keydown", { key: "ArrowDown", target: options[0] });
    expect(options[1].focused).toBe(true);
    fire(fixture.element("#platform-menu"), "keydown", { key: "End", target: options[1] });
    expect(fixture.element("#platform-manage").focused).toBe(true);
    fire(fixture.element("#platform-menu"), "keydown", { key: "Home", target: fixture.element("#platform-manage") });
    expect(options[0].focused).toBe(true);
    fixture.emitDocument("keydown", { key: "Escape" });
    expect(fixture.element("#platform-menu").hidden).toBe(true);
    expect(fixture.element("#platform-entry").attributes.get("aria-expanded")).toBe("false");
    expect(fixture.element("#platform-entry").focused).toBe(true);
    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.api.platformState).toHaveBeenCalledTimes(2));
    fixture.emitDocument("click", { target: fixture.element("#prompt") });
    expect(fixture.element("#platform-menu").hidden).toBe(true);
  });

  it("closes the selector when a task starts and blocks a stale selection without interrupting the task", async () => {
    const fixture = await rendererFixture({ state: vi.fn(async () => researchAppState()), platformState: vi.fn(async () => researchSelection()) });
    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.element("#platform-menu-options").children[0].disabled).toBe(false));
    const disable = fixture.element("#platform-menu-options").children[0];
    fixture.element("#prompt").value = "正在处理的课题";
    const submission = fire(fixture.element("#composer"), "submit");
    await vi.waitFor(() => expect(fixture.api.send).toHaveBeenCalledOnce());
    expect(fixture.element("#platform-menu").hidden).toBe(true);
    fire(disable, "click");
    expect(fixture.api.platformSelect).not.toHaveBeenCalled();
    expect(fixture.api.abort).not.toHaveBeenCalled();
    fixture.completeSend({ sessionId: "research-task", text: "完成" });
    await submission;
  });

  it("does not apply a menu load that finishes after the selector is dismissed", async () => {
    let finishLoad;
    const fixture = await rendererFixture({
      state: vi.fn(async () => researchAppState()),
      platformState: vi.fn(() => new Promise((resolve) => { finishLoad = resolve; })),
    });
    fire(fixture.element("#platform-entry"), "click");
    await vi.waitFor(() => expect(fixture.api.platformState).toHaveBeenCalledOnce());
    fixture.emitDocument("click", { target: fixture.element("#prompt") });
    finishLoad(researchSelection(null));
    await Promise.resolve();
    expect(fixture.element("#platform-menu").hidden).toBe(true);
    expect(fixture.element("#platform-current-name").textContent).toBe("当前：材料测试平台");
    expect(fixture.element("#model-label").textContent).toBe("课题模型");
  });

  it("restores the selected research version without covering the shared version switcher", async () => {
    const fixture = await rendererFixture({ state: vi.fn(async () => ({ experienceMode: "research", configured: false, connections: [], theme: "dark" })) });
    expect(fixture.platforms.open).not.toHaveBeenCalled();
    expect(fixture.api.setExperienceMode).not.toHaveBeenCalled();
    expect(fixture.element("#settings-dialog").open).toBe(true);
  });
  it("opens platforms only for an explicit platform launch", async () => {
    const fixture = await rendererFixture({ state: vi.fn(async () => ({ experienceMode: "research", launchView: "platforms", configured: false, connections: [], theme: "dark" })) });
    expect(fixture.platforms.open).toHaveBeenCalledOnce();
    expect(fixture.api.send).not.toHaveBeenCalled();
    expect(fixture.element("#settings-dialog").open).toBe(false);
  });

  it("shows the platform assistant model only in research mode and keeps the global connection", async () => {
    const fixture = await rendererFixture({ state: vi.fn(async () => ({
      configured: true, experienceMode: "original", activeConnectionId: "global", theme: "dark",
      connections: [
        { id: "global", name: "日常模型", provider: "openai", model: "global-model", configured: true },
        { id: "platform", name: "课题模型", provider: "openai", model: "platform-model", configured: true },
      ],
    })) });
    fixture.platformsOptions.onState({ snapshot: { definition: { assistant: { modelConnectionId: "platform" } } } });
    expect(fixture.element("#model-label").textContent).toBe("global-model");
    await fixture.experiences.selectMode("research");
    expect(fixture.element("#model-label").textContent).toBe("platform-model");
    await fixture.experiences.selectMode("learning");
    expect(fixture.element("#model-label").textContent).toBe("global-model");
    await fixture.experiences.selectMode("original");
    expect(fixture.element("#model-label").textContent).toBe("global-model");
    expect(fixture.api.selectConnection).not.toHaveBeenCalled();
    expect(fixture.api.saveConnection).not.toHaveBeenCalled();
  });

  it("keeps an active task running when the research entry is clicked", async () => {
    const fixture = await rendererFixture();
    fixture.element("#prompt").value = "正在处理的任务";
    const submission = fire(fixture.element("#composer"), "submit");
    await vi.waitFor(() => expect(fixture.api.send).toHaveBeenCalledOnce());

    fire(fixture.element("#platform-entry"), "click");
    expect(fixture.platforms.open).not.toHaveBeenCalled();
    expect(fixture.api.setExperienceMode).not.toHaveBeenCalled();
    expect(fixture.api.abort).not.toHaveBeenCalled();
    expect(fixture.element("#status").textContent).toContain("当前任务结束后");

    fixture.completeSend({ sessionId: "active-task", text: "完成" });
    await submission;
  });

  it("switches from the research panel through the same original and learning version controls", async () => {
    const fixture = await rendererFixture();
    await fixture.platforms.open();
    expect(await fixture.platformsOptions.onSwitchMode("learning")).toBe(true);
    expect(fixture.experiences.selectMode).toHaveBeenCalledWith("learning");
    expect(fixture.api.setExperienceMode).toHaveBeenCalledWith("learning");
    expect(fixture.platforms.isOpen()).toBe(false);
    await fixture.platforms.open();
    expect(await fixture.platformsOptions.onSwitchMode("original")).toBe(true);
    expect(fixture.experiences.selectMode).toHaveBeenCalledWith("original");
    expect(fixture.api.send).not.toHaveBeenCalled();
  });

  it("restores the research panel if saving the selected version fails", async () => {
    const fixture = await rendererFixture();
    await fixture.platforms.open();
    fixture.experiences.selectMode.mockResolvedValue(false);
    expect(await fixture.platformsOptions.onSwitchMode("learning")).toBe(false);
    expect(fixture.platforms.isOpen()).toBe(true);
  });

  it("opens the plugin market and routes Pi community directories through Desktop", async () => {
    const fixture = await rendererFixture();
    fire(fixture.element("#plugin-market"), "click");
    expect(fixture.element("#plugin-market-dialog").open).toBe(true);
    fire(fixture.element("#open-pi-community-popular"), "click");
    fire(fixture.element("#open-pi-community-github"), "click");
    fire(fixture.element("#open-pi-community-reddit"), "click");
    await vi.waitFor(() => expect(fixture.api.openMarket).toHaveBeenNthCalledWith(1, "pi-community-popular"));
    expect(fixture.api.openMarket).toHaveBeenNthCalledWith(2, "pi-community-github");
    expect(fixture.api.openMarket).toHaveBeenNthCalledWith(3, "pi-community-reddit");
  });

  it("hydrates catalog, workspace, active model, permission, and dark theme from state", async () => {
    const fixture = await rendererFixture();
    expect(fixture.element("#workspace-label").textContent).toBe("Project");
    expect(fixture.element("#model-label").textContent).toBe("gpt-5");
    expect(fixture.element("#permission-label").textContent).toBe("每次询问");
    expect(fixture.document.documentElement.dataset.theme).toBe("dark");

    await fire(fixture.element("#settings"), "click");
    const providers = fixture.element("#provider").children.map((option) => option.value);
    expect(providers).toEqual(["openai", "anthropic", "deepseek", "openai-compatible"]);
    expect(fixture.element("#model-suggestions").children[0].value).toBe("gpt-5");
  });


  it("uses Pi catalog defaults for built-in providers without leaking a previous provider Base URL", async () => {
    const fixture = await rendererFixture();
    fire(fixture.element("#settings"), "click");
    fire(fixture.element("#new-connection"), "click");
    expect(fixture.element("#provider").value).toBe("deepseek");
    expect(fixture.element("#model").value).toBe("deepseek-chat");
    expect(fixture.element("#base-url").value).toBe("");

    fixture.element("#base-url").value = "https://api.deepseek.com";
    fixture.element("#provider").value = "anthropic";
    fire(fixture.element("#provider"), "change");
    expect(fixture.element("#base-url").value).toBe("");
    expect(fixture.element("#model").value).toBe("claude-sonnet-4-5");
    expect(fixture.element("#api-key").placeholder).toContain("sk-ant-oat");
    expect(fixture.element("#connection-auth-copy").textContent).toContain("Claude Code");
  });

  it("persists workspace, permission mode, and light theme through the desktop API", async () => {
    const fixture = await rendererFixture();
    fire(fixture.element("#workspace-chip"), "click");
    await vi.waitFor(() => expect(fixture.api.chooseWorkspace).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(fixture.element("#workspace-label").textContent).toBe("Next"));

    fire(fixture.permissionButtons[2], "click");
    await vi.waitFor(() => expect(fixture.api.setPermissionMode).toHaveBeenCalledWith("bypass"));
    await vi.waitFor(() => expect(fixture.element("#permission-label").textContent).toBe("完全访问（不审批）"));

    fire(fixture.themeButtons[1], "click");
    await vi.waitFor(() => expect(fixture.api.setTheme).toHaveBeenCalledWith("light"));
    expect(fixture.document.documentElement.dataset.theme).toBe("light");
  });

  it("opens the permission menu above its button, selects every mode and restores focus", async () => {
    const fixture = await rendererFixture(), chip = fixture.element("#permission-chip"), menu = fixture.element("#permission-menu");
    for (const [index, mode] of ["ask", "workspace-write", "bypass"].entries()) {
      fire(chip, "click");
      expect(menu.hidden).toBe(false); expect(chip.attributes.get("aria-expanded")).toBe("true");
      expect(menu.style.top).toBe("408px"); expect(menu.style.left).toBe("600px");
      fire(fixture.permissionButtons[index], "click");
      await vi.waitFor(() => expect(fixture.api.setPermissionMode).toHaveBeenLastCalledWith(mode));
      await vi.waitFor(() => expect(menu.hidden).toBe(true));
      expect(chip.attributes.get("aria-expanded")).toBe("false"); expect(chip.focused).toBe(true);
      expect(fixture.permissionButtons[index].attributes.get("aria-checked")).toBe("true");
    }
  });

  it("keeps the permission menu in the viewport on resize and follows horizontal context scrolling", async () => {
    const fixture = await rendererFixture(), chip = fixture.element("#permission-chip"), menu = fixture.element("#permission-menu");
    fixture.window.innerWidth = 320; fixture.window.innerHeight = 500;
    chip.bounds = { left: 280, right: 390, top: 330, bottom: 362 };
    fire(chip, "click");
    expect(menu.style.width).toBe("290px"); expect(menu.style.left).toBe("18px"); expect(menu.style.top).toBe("118px");
    fixture.window.innerHeight = 250; chip.bounds.top = 150; chip.bounds.bottom = 182;
    fixture.emitWindow("resize");
    expect(menu.style.top).toBe("12px"); expect(menu.style.maxHeight).toBe("130px");
    fixture.window.innerWidth = 1120; fixture.window.innerHeight = 820;
    chip.bounds = { left: 40, right: 150, top: 300, bottom: 332 };
    fire(fixture.element(".composer-dock > .context-bar"), "scroll");
    expect(menu.style.left).toBe("40px"); expect(menu.style.top).toBe("88px");
    fixture.emitDocument("click", { target: fixture.element("#prompt") });
    expect(menu.hidden).toBe(true);
  });

  it("lets keyboard users open, navigate and dismiss the permission menu", async () => {
    const fixture = await rendererFixture(), chip = fixture.element("#permission-chip"), menu = fixture.element("#permission-menu");
    fire(chip, "keydown", { key: "ArrowDown" });
    expect(menu.hidden).toBe(false); expect(fixture.permissionButtons[0].focused).toBe(true);
    fire(menu, "keydown", { key: "End", target: fixture.permissionButtons[0] });
    expect(fixture.permissionButtons[2].focused).toBe(true);
    fire(menu, "keydown", { key: "ArrowDown", target: fixture.permissionButtons[2] });
    expect(fixture.permissionButtons[0].focused).toBe(true);
    fire(menu, "keydown", { key: "Escape" });
    expect(menu.hidden).toBe(true); expect(chip.focused).toBe(true);
  });

  it("saves a mainstream or relay connection without rendering its API key", async () => {
    const fixture = await rendererFixture();
    fire(fixture.element("#settings"), "click");
    fire(fixture.element("#new-connection"), "click");
    fixture.element("#connection-name").value = "公司中转";
    fixture.element("#provider").value = "openai-compatible";
    fixture.element("#model").value = "company/model-v2";
    fixture.element("#base-url").value = "https://relay.example/v1";
    fixture.element("#api-key").value = "TOKEN";

    await fire(fixture.element("#settings-form"), "submit");
    expect(fixture.api.saveConnection).toHaveBeenCalledWith({
      name: "公司中转",
      provider: "openai-compatible",
      model: "company/model-v2",
      baseUrl: "https://relay.example/v1",
      apiKey: "TOKEN",
    });
    expect(fixture.element("#api-key").value).toBe("");
    expect(fixture.element("#model-label").textContent).toBe("company/model-v2");
  });

  it("pastes an API key from the system clipboard with the explicit paste control", async () => {
    const fixture = await rendererFixture();
    fire(fixture.element("#settings"), "click");
    fixture.element("#api-key").value = "sk-ant-";
    fixture.element("#api-key").selectionStart = 7;
    fixture.element("#api-key").selectionEnd = 7;
    await fire(fixture.element("#paste-api-key"), "click");
    expect(fixture.api.readClipboardText).toHaveBeenCalledOnce();
    expect(fixture.element("#api-key").value).toBe("sk-ant-clipboard-key");
    expect(fixture.element("#api-key").focused).toBe(true);
  });


  it("allows Pi adapters to resolve environment or OAuth credentials when Desktop has no stored key", async () => {
    const fixture = await rendererFixture({
      state: vi.fn(async () => ({
        activeConnectionId: "oauth",
        catalog: [{ id: "openai-codex", name: "OpenAI Codex", models: [{ id: "codex-model" }] }],
        configured: false,
        connections: [{ id: "oauth", name: "Codex", provider: "openai-codex", model: "codex-model" }],
        name: "BuildMe",
        permissionMode: "ask",
        theme: "system",
        workspace: null,
      })),
    });
    fixture.element("#settings-dialog").close();
    fixture.element("#prompt").value = "use oauth";
    const submission = fire(fixture.element("#composer"), "submit");
    await vi.waitFor(() => expect(fixture.api.send).toHaveBeenCalledWith({ sessionId: undefined, prompt: "use oauth" }));
    fixture.completeSend({ sessionId: "oauth-session", text: "done" });
    await submission;
  });

  it("binds a new chat to the first stream session and turns Send into Cancel", async () => {
    const fixture = await rendererFixture();
    const prompt = fixture.element("#prompt");
    const composer = fixture.element("#composer");
    const send = fixture.element("#send");
    prompt.value = "new question";

    const submission = fire(composer, "submit");
    await vi.waitFor(() => expect(fixture.api.send).toHaveBeenCalledWith({ sessionId: undefined, prompt: "new question" }));
    expect(send.type).toBe("button");
    expect(send.textContent).toBe("■");
    expect(fixture.xray.beginRun).toHaveBeenCalledWith(fixture.element("#messages").children.at(-1));

    fixture.emitStream({ type: "response-start", sessionId: "new-session" });
    fixture.emitStream({ type: "reasoning", sessionId: "new-session", delta: "先核对真实资料" });
    fixture.advance();
    const thought = fixture.element("#messages").children.find(node => node.className === "message-reasoning");
    expect(thought.open).toBe(true); expect(thought.children[1].textContent).toBe("先核对真实资料");
    fixture.emitStream({ type: "text", sessionId: "new-session", delta: "streamed answer" });
    fixture.advance();
    expect(fixture.element("#messages").children.at(-1).textContent.trimEnd()).toBe("streamed answer");
    await fire(send, "click");
    await vi.waitFor(() => expect(fixture.api.abort).toHaveBeenCalledWith("new-session"));
    fixture.completeSend({ sessionId: "new-session", text: "streamed answer", messageCount: 2 });
    await submission;
    expect(send.type).toBe("submit");
    expect(send.textContent).toBe("↑");
    expect(fixture.xray.endRun).toHaveBeenCalledOnce();
    expect(thought.children[0].textContent).toContain("已取消");
    expect(thought.children[1].textContent).toBe("先核对真实资料");
  });

  it("shows ask-mode tool approvals and returns the explicit decision", async () => {
    const fixture = await rendererFixture();
    fixture.emitApproval({ requestId: "approval-1", toolName: "write_file", arguments: { path: "/tmp/a.txt" } });
    expect(fixture.element("#approval-dialog").open).toBe(true);
    expect(fixture.element("#approval-tool").textContent).toBe("write_file");
    expect(fixture.element("#approval-arguments").textContent).toContain("/tmp/a.txt");
    fire(fixture.approvalButtons.allow, "click");
    await vi.waitFor(() => expect(fixture.api.respondApproval).toHaveBeenCalledWith("approval-1", true));
    expect(fixture.element("#approval-dialog").open).toBe(false);
  });
});
