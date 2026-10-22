import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { ACHIEVEMENTS, AchievementEngine } from "../src/core/achievements.ts";
import { CapabilityUsageStore } from "../src/core/capability-usage.ts";
import { CAPABILITIES, ALL_CAPABILITIES, resolveCapabilities, toggleCapability } from "../src/core/capabilities.ts";
import { TraceStore } from "../src/core/trace-store.ts";
import { redactTrace } from "../src/core/trace-redact.ts";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const appData = mkdtempSync(join(tmpdir(), "my-agent-desktop-main-"));
const workspace = join(appData, "workspace");
mkdirSync(workspace);
const canonicalWorkspace = realpathSync(workspace);
const originalCwd = process.cwd();
const originalApiKey = process.env.DEEPSEEK_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const ipcHandlers = new Map();
const runtimeListeners = new Map();
const windows = [];
const nativeTheme = { themeSource: "system", on: vi.fn(), removeListener: vi.fn() };
const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: join(appData, "learning-export.json") })), showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) };
const clipboard = { readText: vi.fn(() => "clipboard-key"), writeText: vi.fn() };
const shell = { openExternal: vi.fn(async () => ""), openPath: vi.fn(async () => "") };
const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value) => Buffer.from([...value].reverse().join(""), "utf8")),
  decryptString: vi.fn((value) => value.toString("utf8").split("").reverse().join("")),
};
writeFileSync(join(appData, "desktop-settings.json"), `${JSON.stringify({ deepseekApiKey: "legacy-secret" })}\n`, { mode: 0o600 });
writeFileSync(join(appData, "profile.json"), `${JSON.stringify({
  schemaVersion: 1,
  settings: {
    name: "BuildMe",
    home: ".",
    agent: { provider: "deepseek", model: "deepseek-v4-flash", systemPrompt: "personal" },
  },
  plugins: [
    { id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" },
    { id: "core.models" }, { id: "model.pi-ai-deepseek" }, { id: "prompt.personal" },
    { id: "tool.workspace-info" }, { id: "policy.allow-list", config: { allowed: ["workspace_info"] } },
    { id: "runtime.pi" },
  ],
}, null, 2)}\n`, { mode: 0o600 });

let completeCreate;
const agents = {
  list: vi.fn(() => [{ id: "active-session", status: "busy" }]),
  abort: vi.fn(() => true),
  run: vi.fn(async () => ({ sessionId: "new-session", text: "done" })),
};
const runtime = {
  ctx: {
    on: vi.fn((name, listener) => {
      runtimeListeners.set(name, listener);
      return vi.fn();
    }),
    sessions: {
      list: vi.fn(async () => []),
      read: vi.fn(async () => []),
    },
    llm: {
      catalog: vi.fn(() => [
        {
          id: "deepseek",
          name: "DeepSeek",
          models: [{
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            api: "openai-completions",
            reasoning: true,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
          }],
        },
        {
          id: "amazon-bedrock",
          name: "Amazon Bedrock",
          models: [],
        },
      ]),
      authSummary: vi.fn(async (provider) => provider === "amazon-bedrock"
        ? "aws from ambient credentials"
        : "provider is not registered or configured"),
    },
    agents,
  },
  stop: vi.fn(async () => undefined),
};
const createApp = vi.fn(() => new Promise((resolve) => {
  completeCreate = () => resolve(runtime);
}));

class MockBrowserWindow {
  static getAllWindows() {
    return windows;
  }

  constructor(options) {
    this.options = options;
    this.webContents = { send: vi.fn(), setWindowOpenHandler: vi.fn() };
    this.listeners = new Map();
    windows.push(this);
  }

  removeMenu() {}
  loadFile() {}
  isDestroyed() { return false; }
  on(name, listener) { this.listeners.set(name, listener); }
}

beforeAll(async () => {
  process.env.DEEPSEEK_API_KEY = "inherited-key";
  delete process.env.OPENAI_API_KEY;
  vi.doMock("electron", () => ({
    app: {
      getPath: vi.fn(() => appData),
      on: vi.fn(),
      quit: vi.fn(),
      setName: vi.fn(),
      whenReady: vi.fn(async () => undefined),
    },
    BrowserWindow: MockBrowserWindow,
    dialog,
    ipcMain: {
      handle: vi.fn((name, handler) => ipcHandlers.set(name, handler)),
    },
    Menu: { buildFromTemplate: vi.fn((template) => template), setApplicationMenu: vi.fn() },
    clipboard,
    shell,
    nativeTheme,
    Notification: class { static isSupported() { return false; } on() {} show() {} },
    safeStorage,
    session: { defaultSession: { setPermissionRequestHandler: vi.fn(), resolveProxy: vi.fn(async () => "DIRECT") } },
  }));
  vi.doMock("../dist/index.js", () => ({
    applyProxyFromEnv: vi.fn(() => false),
    hasProxyEnv: vi.fn(() => false),
    proxyUrlFromPac: vi.fn(() => undefined),
    createApp, TraceStore, redactTrace, CapabilityUsageStore, AchievementEngine, ACHIEVEMENTS, CAPABILITIES, ALL_CAPABILITIES, resolveCapabilities, toggleCapability,
    initProfile: vi.fn(async (path) => path),
    loadProfile: vi.fn(async () => ({ profile: { settings: { name: "BuildMe" } } })),
  }));
  await import("../desktop/main.mjs");
  await vi.waitFor(() => expect(windows).toHaveLength(1));
});

afterAll(() => {
  vi.doUnmock("electron");
  vi.doUnmock("../dist/index.js");
  process.chdir(originalCwd);
  rmSync(appData, { recursive: true, force: true });
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("Desktop main-process state", () => {
  it("opens web links in the system browser and denies local or executable link targets", () => {
    const handler = windows[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(handler({ url: "https://example.com/answer" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledWith("https://example.com/answer");
    const calls = shell.openExternal.mock.calls.length;
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "custom:launch"]) expect(handler({ url })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledTimes(calls);
  });
  it("provides clipboard text to the explicit API key paste control", () => {
    expect(ipcHandlers.get("desktop:read-clipboard-text")()).toBe("clipboard-key");
    expect(clipboard.readText).toHaveBeenCalled();
  });

  it("opens only the registered Pi community marketplace destinations", async () => {
    const openMarket = ipcHandlers.get("desktop:open-market");
    await expect(openMarket(undefined, "pi-community-popular")).resolves.toBe("https://pi.dev/packages");
    await expect(openMarket(undefined, "pi-community-github")).resolves.toContain("github.com/search");
    await expect(openMarket(undefined, "pi-community-reddit")).resolves.toContain("r/PiCodingAgent");
    await expect(openMarket(undefined, "openai-plugins")).rejects.toThrow("插件市场来源不正确");
    await expect(openMarket(undefined, "unknown")).rejects.toThrow("插件市场来源不正确");
    expect(shell.openExternal).toHaveBeenCalledWith("https://pi.dev/packages");
  });
  it("shares one harness initialization and returns a complete, secret-free state with the Pi catalog", async () => {
    const pendingState = ipcHandlers.get("desktop:state")();
    const pendingSessions = ipcHandlers.get("desktop:sessions")();
    await vi.waitFor(() => expect(createApp).toHaveBeenCalledTimes(1));
    completeCreate();
    const [state, sessions] = await Promise.all([pendingState, pendingSessions]);
    expect(sessions).toEqual([]);
    expect(state).toMatchObject({
      name: "BuildMe",
      configured: true,
      activeConnectionId: "deepseek-default",
      workspace: null,
      permissionMode: "ask",
      theme: "system",
    });
    expect(state.catalog).toEqual(runtime.ctx.llm.catalog());
    expect(state.connections[0]).toMatchObject({
      id: "deepseek-default",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      configured: true,
      active: true,
    });
    expect(JSON.stringify(state)).not.toContain("inherited-key");
    expect(JSON.stringify(state)).not.toContain("legacy-secret");
    expect(JSON.stringify(state)).not.toContain("apiKey");
    expect(runtime.ctx.on).toHaveBeenCalledTimes(3);
    expect(runtimeListeners.has("piharness/agent-event")).toBe(true);
    expect(runtimeListeners.has("piharness/tool-approval-request")).toBe(true);
		const migratedProfile = JSON.parse(readFileSync(join(appData, "profile.json"), "utf8"));
		const pluginIds = migratedProfile.plugins.map((plugin) => plugin.id);
		expect(pluginIds).toContain("model.pi-ai-builtins");
		expect(pluginIds).toContain("tool.workspace-tools-pi");
		expect(pluginIds).toContain("policy.permission-mode");
		expect(pluginIds).not.toContain("model.pi-ai-deepseek");
		expect(pluginIds).not.toContain("policy.allow-list");

    await ipcHandlers.get("desktop:set-theme")(undefined, "system");
    const migrated = readFileSync(join(appData, "desktop-settings.json"), "utf8");
    expect(migrated).not.toContain("legacy-secret");
    expect(JSON.parse(migrated).connections[0]).toHaveProperty("apiKeyEncrypted");
  });

  it("persists capabilities, dependencies and onboarding independently of running rounds", async () => {
    const state = await ipcHandlers.get("desktop:state")();
    expect(state.capabilityOnboarding).toBe(true);
    expect(state.capabilities).toEqual(["core"]);
    expect(state.capabilityRegistry).toHaveLength(10);
    const choose = ipcHandlers.get("desktop:choose-capabilities");
    const toggle = ipcHandlers.get("desktop:set-capability");
    expect((await choose(undefined, "minimal")).capabilityOnboarding).toBe(false);
    expect((await toggle(undefined, "workflow", true)).capabilities).toEqual(["core", "subagents", "workflow"]);
    expect((await toggle(undefined, "subagents", false)).capabilities).toEqual(["core"]);
    await expect(toggle(undefined, "core", false)).rejects.toThrow("不能关闭");
    await expect(toggle(undefined, "invalid", true)).rejects.toThrow("未知能力");
    await expect(choose(undefined, "invalid")).rejects.toThrow("请选择");
    expect((await choose(undefined, "all")).capabilities).toEqual(ALL_CAPABILITIES);
    expect(JSON.parse(readFileSync(join(appData, "desktop-settings.json"), "utf8")).capabilities).toEqual(ALL_CAPABILITIES);
    await choose(undefined, "minimal");
  });

  it("keeps Desktop secrets request-scoped and leaves inherited environment variables unchanged", async () => {
    const saveKey = ipcHandlers.get("desktop:save-key");
    await expect(saveKey(undefined, " desktop-key ")).resolves.toEqual({ configured: true });
    expect(process.env.DEEPSEEK_API_KEY).toBe("inherited-key");

    await expect(saveKey(undefined, "   ")).resolves.toEqual({ configured: true });
    expect(process.env.DEEPSEEK_API_KEY).toBe("inherited-key");
    const stored = JSON.parse(readFileSync(join(appData, "desktop-settings.json"), "utf8"));
    expect(stored).not.toHaveProperty("deepseekApiKey");
    expect(stored.connections[0]).not.toHaveProperty("apiKey");
    expect(stored.connections[0]).not.toHaveProperty("apiKeyEncrypted");
    if (process.platform !== "win32") expect(statSync(join(appData, "desktop-settings.json")).mode & 0o777).toBe(0o600);
  });

  it("persists multiple connections and returns only redacted metadata", async () => {
    const saveConnection = ipcHandlers.get("desktop:save-connection");
    const state = await saveConnection(undefined, {
      id: "proxy-main",
      name: "我的中转站",
      provider: "openai-compatible",
      model: "gpt-5",
      baseUrl: "https://proxy.example.test/v1/",
      apiKey: "proxy-secret",
      makeActive: true,
    });

    expect(state.activeConnectionId).toBe("proxy-main");
    expect(state.connections).toHaveLength(2);
    expect(state.connections[1]).toEqual({
      id: "proxy-main",
      name: "我的中转站",
      provider: "openai-compatible",
      model: "gpt-5",
      baseUrl: "https://proxy.example.test/v1",
      configured: true,
      active: true,
    });
    expect(JSON.stringify(state)).not.toContain("proxy-secret");
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const stored = JSON.parse(readFileSync(join(appData, "desktop-settings.json"), "utf8"));
    expect(stored.connections[1]).not.toHaveProperty("apiKey");
    expect(stored.connections[1]).toHaveProperty("apiKeyEncrypted");
    expect(JSON.stringify(stored)).not.toContain("proxy-secret");
  });

  it("passes the selected connection, workspace, and permission mode into the Agent run", async () => {
    await expect(ipcHandlers.get("desktop:set-workspace")(undefined, workspace)).resolves.toEqual({
      path: canonicalWorkspace,
      name: "workspace",
    });
    await expect(ipcHandlers.get("desktop:set-permission-mode")(undefined, "workspace-write")).resolves.toBe("workspace-write");
    await expect(ipcHandlers.get("desktop:send")(undefined, { prompt: " hello " })).resolves.toMatchObject({ sessionId: "new-session" });
    expect(agents.run).toHaveBeenLastCalledWith("hello", {
      connection: {
        provider: "openai-compatible",
        model: "gpt-5",
        apiKey: "proxy-secret",
        baseUrl: "https://proxy.example.test/v1",
      },
      workspacePath: canonicalWorkspace,
      permissionMode: "workspace-write",
      edition: "full",
      capabilities: ["core"],
      recordRawRequests: true,
    });
  });

  it("uses the native folder picker and preserves the current workspace when canceled", async () => {
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(ipcHandlers.get("desktop:choose-workspace")()).resolves.toEqual({ path: canonicalWorkspace, name: "workspace" });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      windows[0],
      expect.objectContaining({ properties: ["openDirectory", "createDirectory"], defaultPath: canonicalWorkspace }),
    );
  });

  it("allows a catalog provider to use ambient provider auth and requires a URL for unknown providers", async () => {
    const saveConnection = ipcHandlers.get("desktop:save-connection");
    await saveConnection(undefined, {
      id: "bedrock-ambient",
      name: "Bedrock",
      provider: "amazon-bedrock",
      model: "claude",
      makeActive: true,
    });
    await ipcHandlers.get("desktop:send")(undefined, { prompt: "ambient" });
    expect(agents.run).toHaveBeenLastCalledWith("ambient", expect.objectContaining({
      connection: { provider: "amazon-bedrock", model: "claude" },
    }));

    await saveConnection(undefined, {
      id: "unknown-provider",
      name: "Unknown",
      provider: "private-provider",
      model: "private-model",
      makeActive: true,
    });
    await expect(ipcHandlers.get("desktop:send")(undefined, { prompt: "unknown" })).rejects.toThrow("Base URL");
  });

  it("persists and validates permission and theme selections", async () => {
    await expect(ipcHandlers.get("desktop:set-permission-mode")(undefined, "bypass")).resolves.toBe("bypass");
    await expect(ipcHandlers.get("desktop:set-theme")(undefined, "light")).resolves.toBe("light");
    expect(nativeTheme.themeSource).toBe("light");
    const state = await ipcHandlers.get("desktop:state")();
    expect(state).toMatchObject({ permissionMode: "bypass", theme: "light" });
    await expect(ipcHandlers.get("desktop:set-permission-mode")(undefined, "root")).rejects.toThrow("权限模式");
  });

  it.each([true, false])("bridges a core approval request and preserves the answer %s", async (allow) => {
    await ipcHandlers.get("desktop:set-permission-mode")(undefined, "ask");
    const requestId = `answer-${allow}`;
    const approval = runtimeListeners.get("piharness/tool-approval-request")({
      requestId,
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "write_file",
      args: { path: "note.md" },
      workspacePath: canonicalWorkspace,
      permissionMode: "ask",
    });
    await vi.waitFor(() => expect(windows[0].webContents.send).toHaveBeenCalledWith("desktop:approval", expect.objectContaining({ requestId })));
    const [, request] = windows[0].webContents.send.mock.calls.find(([channel, payload]) => channel === "desktop:approval" && payload.requestId === requestId);
    expect(request).toMatchObject({
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "write_file",
      args: { path: "note.md" },
      permissionMode: "ask",
    });
    expect(ipcHandlers.get("desktop:approval-response")(undefined, request.requestId, allow)).toEqual({ accepted: true });
    await expect(approval).resolves.toEqual(allow ? true : { decision: "deny" });
    expect(ipcHandlers.get("desktop:approval-response")(undefined, request.requestId, false)).toEqual({ accepted: false });
  });

  it("auto-approves core requests in bypass mode without notifying the renderer", async () => {
    await ipcHandlers.get("desktop:set-permission-mode")(undefined, "bypass");
    await ipcHandlers.get("desktop:achievements")();
    const sends = windows[0].webContents.send.mock.calls.length;
    await expect(runtimeListeners.get("piharness/tool-approval-request")({ toolName: "shell" })).resolves.toBe(true);
    expect(windows[0].webContents.send.mock.calls).toHaveLength(sends);
  });

  it("keeps cancellation and approval timeout distinct from a user denial", async () => {
    await ipcHandlers.get("desktop:set-permission-mode")(undefined, "ask");
    const request = runtimeListeners.get("piharness/tool-approval-request");
    const cancelled = request({ requestId: "cancelled-test", sessionId: "session-to-cancel", toolName: "bash", permissionMode: "ask" });
    await vi.waitFor(() => expect(windows[0].webContents.send).toHaveBeenCalledWith("desktop:approval", expect.objectContaining({ requestId: "cancelled-test" })));
    await ipcHandlers.get("desktop:abort")(undefined, "session-to-cancel");
    await expect(cancelled).resolves.toEqual({ decision: "cancelled" });
    vi.useFakeTimers();
    try {
      const expired = request({ requestId: "timeout-test", sessionId: "session-timeout", toolName: "bash", permissionMode: "ask" });
      await vi.waitFor(() => expect(windows[0].webContents.send).toHaveBeenCalledWith("desktop:approval", expect.objectContaining({ requestId: "timeout-test" })));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await expect(expired).resolves.toEqual({ decision: "timeout" });
      expect(ipcHandlers.get("desktop:approval-response")(undefined, "timeout-test", false)).toEqual({ accepted: false });
    } finally { vi.useRealTimers(); }
  });

  it("validates UI learning events and exports only achievements, capabilities and counters", async () => {
    const event = ipcHandlers.get("desktop:learning-event");
    await expect(event(undefined, { id: "view", type: "compare-completed" })).rejects.toThrow("类型不正确");
    await expect(event(undefined, { id: "view", type: "xray-tab", tab: "invalid" })).rejects.toThrow("标签不正确");
    await event(undefined, { id: "view", type: "xray-opened" });
    await event(undefined, { id: "view", type: "xray-opened" });
    const exported = await ipcHandlers.get("desktop:export-learning")();
    const data = JSON.parse(readFileSync(exported.path, "utf8"));
    expect(Object.keys(data).sort()).toEqual(["achievements", "capabilities", "counters"]);
    expect(data.counters.xrayOpened).toBe(1);
    expect(JSON.stringify(data)).not.toContain("proxy-secret");
    const state = await ipcHandlers.get("desktop:achievements")();
    expect(state.definitions).toHaveLength(30);
    vi.spyOn(AchievementEngine.prototype, "accept").mockRejectedValueOnce(new Error("storage failed"));
    await expect(event(undefined, { id: "failed-event", type: "xray-opened" })).resolves.toEqual({ accepted: false });
    vi.restoreAllMocks();
  });

  it("does not fall back to plaintext when the OS key store is unavailable", async () => {
    const saveConnection = ipcHandlers.get("desktop:save-connection");
    await saveConnection(undefined, { id: "proxy-main", apiKey: "" });
    safeStorage.isEncryptionAvailable.mockReturnValueOnce(false);
    await expect(saveConnection(undefined, {
      id: "blocked-secret",
      name: "Blocked",
      provider: "openai",
      model: "gpt-5",
      apiKey: "must-not-be-plaintext",
    })).rejects.toThrow("系统密钥存储");
    expect(readFileSync(join(appData, "desktop-settings.json"), "utf8")).not.toContain("must-not-be-plaintext");
  });

  it("cancels the only busy Agent when the renderer has not learned its new session id yet", async () => {
    const abort = ipcHandlers.get("desktop:abort");
    await expect(abort(undefined, undefined)).resolves.toBe(true);
    expect(agents.abort).toHaveBeenLastCalledWith("active-session");
  });

  it("saves raw-request preferences and serves redacted live and historical X 光 data", async () => {
    const setRaw = ipcHandlers.get("desktop:set-record-raw-requests");
    await expect(setRaw(undefined, false)).resolves.toBe(false);
    expect((await ipcHandlers.get("desktop:state")()).recordRawRequests).toBe(false);
    expect(JSON.parse(readFileSync(join(appData, "desktop-settings.json"), "utf8")).recordRawRequests).toBe(false);
    await expect(setRaw(undefined, "false")).rejects.toThrow("选项");
    await setRaw(undefined, true);
    const turn = {
      id: "trace-turn", sessionId: "trace-session", turnIndex: 1, engine: "pi", status: "running",
      startedAt: "2026-10-05T00:00:00Z", userPrompt: "sk-test-AAAAAAAAAAAAAAAAAAAA",
      model: { provider: "faux", id: "faux-1" }, promptSegments: [], events: [],
      fidelity: { promptSegments: true, rawRequest: true, usage: "exact", approvals: true, subagents: false, compaction: true },
      usage: { inputTokens: 10, outputTokens: 2, modelCalls: 1, toolCalls: 0, durationMs: 100 },
    };
    const notify = runtimeListeners.get("piharness/trace");
    notify({ type: "turn-start", turn });
    expect((await ipcHandlers.get("desktop:xray-turn")(undefined, turn.id)).status).toBe("running");
    notify({ type: "turn-end", turn: { ...turn, status: "done" } });
    const summaries = await ipcHandlers.get("desktop:xray-turns")(undefined, turn.sessionId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].usage.inputTokens).toBe(10);
    expect(summaries[0]).not.toHaveProperty("events");
    expect(summaries[0]).not.toHaveProperty("userPrompt");
    const history = await ipcHandlers.get("desktop:xray-turn")(undefined, turn.id);
    expect(history.status).toBe("done");
    expect(JSON.stringify(history)).not.toContain("sk-test-AAAAAAAAAAAAAAAAAAAA");
    expect(JSON.stringify(windows[0].webContents.send.mock.calls.filter(([channel]) => channel === "desktop:xray"))).not.toContain("sk-test-AAAAAAAAAAAAAAAAAAAA");
  });

  it("keeps durable turn indices across filtered messages and intermediate assistant replies", async () => {
    runtime.ctx.sessions.read.mockResolvedValueOnce([
      { type: "user/message", data: { message: { role: "user", content: "" } } },
      { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } } },
      { type: "user/message", data: { message: { role: "user", content: "next" } } },
      { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } } },
      { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "final" }] } } },
    ]);
    const messages = await ipcHandlers.get("desktop:messages")(undefined, "history");
    expect(messages.map(({ text, turnIndex }) => ({ text, turnIndex }))).toEqual([
      { text: "old reply", turnIndex: 1 }, { text: "next", turnIndex: 2 },
      { text: "正在使用：read", turnIndex: 2 }, { text: "final", turnIndex: 2 },
    ]);
  });

  it("opens only recorded text sources and keeps bundled prompt sources read-only", async () => {
    const path = join(canonicalWorkspace, "guide.md");
    const executable = join(canonicalWorkspace, "run.sh");
    writeFileSync(path, "guide"); writeFileSync(executable, "exit 0");
    const sourceTurn = {
      id: "source-turn", sessionId: "sources", turnIndex: 1, engine: "pi", status: "running",
      startedAt: "2026-10-05T00:00:00Z", userPrompt: "test", model: { provider: "faux", id: "faux" },
      promptSegments: [path, "bundles/base/prompts/buildme-tools-dsh.md", executable, "missing-relative.md"].map((sourcePath, index) => ({ name: `section-${index}`, source: "base", sourcePath, text: "test", chars: 4, estTokens: 1 })),
      events: [], fidelity: { promptSegments: true, rawRequest: true, usage: "exact", approvals: true, subagents: true, compaction: true },
      usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 },
    };
    runtimeListeners.get("piharness/trace")({ type: "turn-start", turn: sourceTurn });
    const source = ipcHandlers.get("desktop:xray-prompt-source");
    await expect(source(undefined, "source-turn", 0, false)).resolves.toEqual({ path, readOnly: false });
    expect(shell.openPath).not.toHaveBeenCalled();
    await source(undefined, "source-turn", 0, true);
    expect(shell.openPath).toHaveBeenCalledWith(path);
    await expect(source(undefined, "source-turn", 1, false)).resolves.toMatchObject({ readOnly: true });
    await expect(source(undefined, "source-turn", 1, true)).rejects.toThrow("内置文件");
    await expect(source(undefined, "source-turn", 2, true)).rejects.toThrow("文本文件");
    await expect(source(undefined, "source-turn", 3, true)).rejects.toThrow("相对路径");
    await expect(source(undefined, "source-turn", "0", true)).rejects.toThrow("参数");
    await expect(source(undefined, "unknown", 0, true)).rejects.toThrow("没有记录");
    shell.openPath.mockResolvedValueOnce("no editor");
    await expect(source(undefined, "source-turn", 0, true)).rejects.toThrow("no editor");
  });

  it("copies text through the desktop bridge and rejects non-text clipboard input", () => {
    const copy = ipcHandlers.get("desktop:write-clipboard-text");
    copy(undefined, '{"apiKey":"«已隐藏»"}');
    expect(clipboard.writeText).toHaveBeenCalledWith('{"apiKey":"«已隐藏»"}');
    expect(() => copy(undefined, {})).toThrow("复制内容");
  });

  it("allows the final model connection to be removed", async () => {
    const remove = ipcHandlers.get("desktop:delete-connection");
    let state = await ipcHandlers.get("desktop:state")();
    for (const connection of [...state.connections]) state = await remove(undefined, connection.id);
    expect(state).toMatchObject({ configured: false, connections: [], activeConnectionId: null });
  });
});
