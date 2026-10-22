import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SystemPromptRuntime } from "../src/core/prompt-registry.ts";
import { ACHIEVEMENTS, AchievementEngine } from "../src/core/achievements.ts";
import { CapabilityUsageStore } from "../src/core/capability-usage.ts";
import { CAPABILITIES, ALL_CAPABILITIES, resolveCapabilities, toggleCapability } from "../src/core/capabilities.ts";
import { TraceStore } from "../src/core/trace-store.ts";
import { redactTrace } from "../src/core/trace-redact.ts";
import { experienceInstructions, experienceSystemPrompt, normalizeExperienceMode, requireExperienceMode, withExperienceMode } from "../desktop/experience-mode.mjs";
import { PlatformService } from "../desktop/platform-service.mjs";
import { ChatAttachmentStore } from "../desktop/chat-attachments.mjs";

function promptRegistry() {
  const sections = [];
  return {
    sections,
    list: () => [...sections],
    register: vi.fn((section) => {
      if (sections.some(({ name }) => name === section.name)) throw new Error(`Prompt section already registered: ${section.name}`);
      sections.push(section);
    }),
    render: () => sections.map((section) => section.text()).filter(Boolean).join("\n\n"),
  };
}

describe("Product experience instructions", () => {
  it("reuses the registered section across fresh Cordis service proxies on later turns", async () => {
    const ctx = new Context();
    new SystemPromptRuntime(ctx);
    expect(ctx.systemPrompt).not.toBe(ctx.systemPrompt);
    for (const [mode, context] of [["learning", ""], ["learning", ""], ["research", "platform A"], ["research", "platform B"], ["original", ""], ["original", "platform C"]]) {
      const expected = [experienceInstructions(mode), context].filter(Boolean).join("\n\n");
      await withExperienceMode(ctx.systemPrompt, mode, async () => {
        await Promise.resolve();
        expect(ctx.systemPrompt.render()).toBe(expected);
      }, context);
      expect(ctx.systemPrompt.list()).toHaveLength(1);
      expect(ctx.systemPrompt.render()).toBe("");
    }
  });

  it("defaults legacy settings to original and rejects unsupported modes", () => {
    for (const value of [undefined, null, "standard", "full", {}, "__proto__"]) {
      expect(normalizeExperienceMode(value)).toBe("original");
      expect(() => requireExperienceMode(value)).toThrow("原版、学习版或科研版");
    }
    for (const mode of ["original", "learning", "research"]) expect(normalizeExperienceMode(mode)).toBe(mode);
    expect(experienceSystemPrompt("existing persona", "original")).toBe("existing persona");
  });

  it("isolates concurrent Pi tasks and leaves ordinary/comparison requests untouched", async () => {
    const registry = promptRegistry();
    let releaseLearning;
    const wait = new Promise((resolve) => { releaseLearning = resolve; });
    const learning = withExperienceMode(registry, "learning", async () => {
      expect(registry.render()).toContain("学习版");
      await wait;
      expect(registry.render()).toContain("学习版");
      expect(registry.render()).not.toContain("科研版");
    });
    expect(registry.render()).toBe("");
    await withExperienceMode(registry, "research", async () => {
      await Promise.resolve();
      expect(registry.render()).toContain("科研版");
      expect(registry.render()).not.toContain("学习版");
    });
    await withExperienceMode(registry, "original", async () => expect(registry.render()).toBe(""));
    releaseLearning();
    await learning;
    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(registry.render()).toBe("");
  });

  it("fails explicitly if an educational request cannot obtain its prompt service", () => {
    expect(() => withExperienceMode(undefined, "learning", () => "answer")).toThrow("提示词服务");
    expect(withExperienceMode(undefined, "original", () => "unchanged")).toBe("unchanged");
  });

  it("adds research evidence and reproducibility guidance to the DSH persona", () => {
    const prompt = experienceSystemPrompt("existing DSH persona", "research");
    expect(prompt).toMatch(/^existing DSH persona\n\n/);
    expect(prompt).toContain("绝不编造文献");
    expect(prompt).toContain("可复现");
    expect(prompt).toContain("platform_propose");
    expect(prompt).toContain("platform_execute");
    expect(prompt).toContain("不要求用户回到平台点击运行");
    expect(prompt).toContain("不预设学科");
    expect(prompt).not.toContain("阿尔茨海默");
    expect(prompt).not.toContain("药物化学实验工作台");
    expect(experienceInstructions("learning")).toContain("可观察的行动");
  });
});

describe("Desktop product experience integration", () => {
  const appData = mkdtempSync(join(tmpdir(), "buildme-experience-"));
  const settingsPath = join(appData, "desktop-settings.json");
  const selectedWorkspace = join(appData, "user-selected-workspace");
  const handlers = new Map();
  const engines = [];
  const registry = promptRegistry();
  const observed = [];
  const requestedConnections = [];
  let startupExperienceConfig;
  const agents = {
    list: vi.fn(() => []),
    run: vi.fn(async (prompt, options) => {
      await Promise.resolve();
      requestedConnections.push(options.connection);
      observed.push({ prompt, instructions: registry.render(), scope: { capabilities: options.capabilities, workspacePath: options.workspacePath } });
      return { sessionId: "pi-session", text: "done" };
    }),
  };
  const runtime = { ctx: {
    agents,
    get systemPrompt() { return new Proxy(registry, {}); },
    on: vi.fn(() => vi.fn()),
    llm: { catalog: () => [{ id: "deepseek", name: "DeepSeek", models: [] }] },
  } };

  beforeAll(async () => {
    mkdirSync(selectedWorkspace);
    writeFileSync(settingsPath, JSON.stringify({
      connections: [{ id: "model", name: "Test model", provider: "deepseek", model: "test-model", baseUrl: "https://example.test/v1" }],
      activeConnectionId: "model", permissionMode: "workspace-write", theme: "dark", capabilities: ["core", "todo"], workspacePath: selectedWorkspace,
    }));
    vi.doMock("electron", () => ({
      app: { getPath: () => appData, on: vi.fn(), quit: vi.fn(), setName: vi.fn(), whenReady: () => new Promise(() => {}) },
      BrowserWindow: class {}, dialog: {}, clipboard: {}, shell: {},
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      Menu: { buildFromTemplate: (template) => template, setApplicationMenu: vi.fn() },
      nativeTheme: {}, Notification: {}, safeStorage: {}, session: {},
    }));
    vi.doMock("../dist/index.js", () => ({
      applyProxyFromEnv: vi.fn(), hasProxyEnv: vi.fn(), proxyUrlFromPac: vi.fn(),
      createApp: vi.fn(async () => runtime), initProfile: vi.fn(async (path) => path),
      loadProfile: vi.fn(async () => ({ profile: { settings: { name: "BuildMe" } } })),
      TraceStore, redactTrace, CapabilityUsageStore, AchievementEngine, ACHIEVEMENTS, CAPABILITIES, ALL_CAPABILITIES, resolveCapabilities, toggleCapability,
    }));
    vi.doMock("../desktop/dsh-engine.mjs", () => ({
      ACTIVE_API_KEY_ENV: "BUILDME_ACTIVE_API_KEY",
      fullEditionPrompt: vi.fn(async () => "existing DSH persona"),
      dshRoute: (selected) => ({ provider: "relay", model: selected.model }),
      DshEngine: class {
        constructor(options) { this.options = options; this.running = false; this.requests = []; engines.push(this); }
        async start() { this.running = true; }
        async stop() { this.running = false; }
        async request(method, params) {
          this.requests.push({ method, params });
          if (method === "session/run") return { sessionId: "dsh-session", text: "done", reason: "done" };
          return [];
        }
      },
    }));
    ({ startupExperienceConfig } = await import("../desktop/main.mjs"));
  });

  afterAll(() => {
    vi.doUnmock("electron");
    vi.doUnmock("../dist/index.js");
    vi.doUnmock("../desktop/dsh-engine.mjs");
    rmSync(appData, { recursive: true, force: true });
  });

  it("persists and validates the independent mode while preserving existing settings", async () => {
    const initial = await handlers.get("desktop:state")();
    expect(initial.experienceMode).toBe("original");
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    const changed = await handlers.get("desktop:set-experience-mode")(undefined, "learning");
    expect(changed).toMatchObject({ experienceMode: "learning", edition: "standard", theme: "dark", permissionMode: "workspace-write" });
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after).toMatchObject({ ...before, experienceMode: "learning" });
    await expect(handlers.get("desktop:set-experience-mode")(undefined, "full")).rejects.toThrow("原版、学习版或科研版");
    expect(agents.run).not.toHaveBeenCalled();
    expect(engines).toHaveLength(0);
  });

  it("keeps user capabilities, workspace and model settings across all three modes", async () => {
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const mode of ["research", "original", "research", "learning"]) {
      const state = await handlers.get("desktop:set-experience-mode")(undefined, mode);
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ ...before, experienceMode: mode });
      expect(state.workspace.path).toBe(selectedWorkspace);
      expect(state.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: "model", provider: "deepseek", model: "test-model", baseUrl: "https://example.test/v1" })]));
      expect(state.capabilities).toEqual(mode === "research" ? resolveCapabilities([...before.capabilities, "skills"]) : before.capabilities);
    }
  });

  it("treats the optional research startup flag as a mode choice without changing user defaults", () => {
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    const original = JSON.parse(JSON.stringify(before));
    expect(startupExperienceConfig(before, ["electron", "app"])).toEqual(original);
    expect(startupExperienceConfig(before, ["electron", "app", "--research"])).toEqual({ ...original, experienceMode: "research" });
    expect(startupExperienceConfig(before, ["electron", "app", "--platforms"])).toEqual({ ...original, experienceMode: "research" });
    expect(startupExperienceConfig(before, ["electron", "app", "--research-examples"])).toEqual(original);
    expect(before).toEqual(original);
  });

  it("applies the saved mode to Pi while keeping original user text and clearing scope afterward", async () => {
    await handlers.get("desktop:send")(undefined, { prompt: "explain this project" });
    expect(observed.at(-1)).toMatchObject({ prompt: "explain this project", instructions: expect.stringContaining("学习版") });
    expect(observed.at(-1).scope).toEqual({ workspacePath: selectedWorkspace, capabilities: ["core", "todo"] });
    expect(registry.render()).toBe("");
    await handlers.get("desktop:set-experience-mode")(undefined, "research");
    await handlers.get("desktop:send")(undefined, { prompt: "review my experiment", sessionId: "pi-session" });
    expect(observed.at(-1)).toMatchObject({ prompt: "review my experiment", instructions: expect.stringContaining("科研版") });
    expect(observed.at(-1).scope.capabilities).toEqual(resolveCapabilities(["core", "todo", "skills"]));
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).capabilities).toEqual(["core", "todo"]);
    await handlers.get("desktop:set-experience-mode")(undefined, "original");
    await handlers.get("desktop:send")(undefined, { prompt: "hello" });
    expect(observed.at(-1)).toEqual({ prompt: "hello", instructions: "", scope: { workspacePath: selectedWorkspace, capabilities: ["core", "todo"] } });
  });

  it("reloads the DSH persona on the next request without polluting messages or titles", async () => {
    await handlers.get("desktop:set-experience-mode")(undefined, "research");
    await handlers.get("desktop:set-edition")(undefined, "full");
    expect(engines).toHaveLength(1);
    expect(engines[0].options.systemPrompt).toContain("科研版");
    expect(engines[0].options.cwd).toBe(selectedWorkspace);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ capabilities: ["core", "todo"], workspacePath: selectedWorkspace });
    await handlers.get("desktop:send")(undefined, { prompt: "summarize my paper" });
    expect(engines[0].requests.find(({ method }) => method === "session/run").params.text).toBe("summarize my paper");
    expect(JSON.parse(readFileSync(join(appData, "full-sessions.json"), "utf8"))["dsh-session"].title).toBe("summarize my paper");
    await handlers.get("desktop:set-experience-mode")(undefined, "learning");
    await handlers.get("desktop:sessions")();
    await handlers.get("desktop:messages")(undefined, "dsh-session");
    expect(engines).toHaveLength(1);
    await handlers.get("desktop:send")(undefined, { prompt: "what is a tool", sessionId: "dsh-session" });
    expect(engines).toHaveLength(2);
    expect(engines[0].running).toBe(false);
    expect(engines[1].options.systemPrompt).toContain("学习版");
    expect(engines[1].requests.find(({ method }) => method === "session/run").params).toMatchObject({ text: "what is a tool", sessionId: "dsh-session" });
    await handlers.get("desktop:set-experience-mode")(undefined, "original");
    await handlers.get("desktop:send")(undefined, { prompt: "hello", sessionId: "dsh-session" });
    expect(engines[2].options.systemPrompt).toBe("existing DSH persona");
  });

  it("scopes a default research workspace without persisting it into original or learning settings", async () => {
    await handlers.get("desktop:set-edition")(undefined, "standard");
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    const withoutWorkspace = { ...before }; delete withoutWorkspace.workspacePath;
    writeFileSync(settingsPath, JSON.stringify(withoutWorkspace));
    try {
      await handlers.get("desktop:set-experience-mode")(undefined, "research");
      await handlers.get("desktop:send")(undefined, { prompt: "Use a research workspace" });
      expect(observed.at(-1).scope.workspacePath).toBe(join(appData, "platform-workspace"));
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ ...withoutWorkspace, experienceMode: "research" });
      await handlers.get("desktop:set-edition")(undefined, "full");
      expect(engines.at(-1).options.cwd).toBe(join(appData, "platform-workspace"));
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ ...withoutWorkspace, experienceMode: "research", edition: "full" });
      await handlers.get("desktop:set-experience-mode")(undefined, "original");
      expect((await handlers.get("desktop:state")()).workspace).toBeNull();
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).capabilities).toEqual(withoutWorkspace.capabilities);
    } finally {
      await handlers.get("desktop:set-edition")(undefined, "standard");
      writeFileSync(settingsPath, JSON.stringify(before));
    }
  });

  it("passes complete table attachment paths to Pi and DSH only with an enabled research platform", async () => {
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    const workspace = join(appData, "chat-table-workspace"); mkdirSync(workspace);
    const source = join(appData, "聊天数据.csv"); writeFileSync(source, "value\n12\n24\n");
    const attachmentStore = new ChatAttachmentStore(join(appData, "chat-attachments"));
    const attachment = (await attachmentStore.add([source])).attachments[0];
    writeFileSync(settingsPath, JSON.stringify({ ...before, workspacePath: workspace, edition: "standard", experienceMode: "research" }));
    const service = new PlatformService({ userData: appData, getWorkspace: async () => workspace });
    try {
      await service.create({ schemaVersion: 1, name: "聊天表格平台", pages: [{ id: "data", title: "测量", kind: "records", fields: [{ id: "value", label: "value", type: "number" }] }], capabilities: ["records", "files"], assistant: { role: "助手", instructions: "保留来源" }, workflows: [] });
      await handlers.get("desktop:send")(undefined, { prompt: "导入这个表格", attachmentIds: [attachment.id] });
      const extract = prompt => JSON.parse(prompt.split("<buildme-chat-attachments>\n")[1].split("\n</buildme-chat-attachments>")[0]);
      const inputPath = extract(observed.at(-1).prompt).files[0].sourcePath;
      expect(inputPath).toContain(`.buildme/platform-inputs/${attachment.id}/`);
      expect(readFileSync(join(workspace, inputPath), "utf8")).toBe("value\n12\n24\n");
      expect(observed.at(-1).instructions).toContain("platform_execute");
      await handlers.get("desktop:set-edition")(undefined, "full");
      await handlers.get("desktop:send")(undefined, { prompt: "导入这个表格", attachmentIds: [attachment.id] });
      const request = engines.at(-1).requests.find(({ method }) => method === "session/run");
      expect(extract(request.params.text).files[0].sourcePath).toBe(inputPath);
      await service.select(null);
      await handlers.get("desktop:set-edition")(undefined, "standard");
      await handlers.get("desktop:send")(undefined, { prompt: "只阅读表格", attachmentIds: [attachment.id] });
      expect(extract(observed.at(-1).prompt).files[0].sourcePath).toBeUndefined();
    } finally {
      await handlers.get("desktop:set-edition")(undefined, "standard");
      writeFileSync(settingsPath, JSON.stringify(before));
    }
  });

  it("uses the platform model in Pi and DSH without changing the original and learning model", async () => {
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    const scopedWorkspace = join(appData, "scoped-model-workspace"); mkdirSync(scopedWorkspace);
    const connections = [...before.connections, { id: "platform-model", name: "平台模型", provider: "deepseek", model: "research-model", baseUrl: "https://platform.example.test/v1" }];
    writeFileSync(settingsPath, JSON.stringify({ ...before, connections, workspacePath: scopedWorkspace, edition: "standard", experienceMode: "research" }));
    const service = new PlatformService({ userData: appData, getWorkspace: async () => scopedWorkspace });
    try {
      await service.create({ schemaVersion: 1, name: "我的材料平台", pages: [{ id: "records", title: "测量", kind: "records", fields: [{ id: "value", label: "响应", type: "number" }] }],
        capabilities: ["records"], assistant: { role: "材料助手", instructions: "检查原始数据", modelConnectionId: "platform-model" }, workflows: [] });
      const platformState = await handlers.get("desktop:state")();
      expect(platformState.platformModelConnectionId).toBe("platform-model");
      expect(platformState.activeResearchPlatform).toMatchObject({ name: "我的材料平台", version: 1 });
      await handlers.get("desktop:send")(undefined, { prompt: "请检查我的平台" });
      expect(requestedConnections.at(-1).model).toBe("research-model");
      expect(observed.at(-1).instructions).toContain("我的材料平台");
      expect(observed.at(-1).instructions).toContain("platform_execute");
      expect(observed.at(-1).instructions).not.toContain("阿尔兹海默");
      await handlers.get("desktop:set-edition")(undefined, "full");
      await handlers.get("desktop:send")(undefined, { prompt: "full research" });
      expect(engines.at(-1).requests.find(({ method }) => method === "session/run").params.model).toBe("research-model");
      expect(engines.at(-1).options.systemPrompt).toContain("platform_execute");
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).activeConnectionId).toBe(before.activeConnectionId);
      await service.select(null);
      const disabled = await handlers.get("desktop:state")();
      expect(disabled.activeResearchPlatform).toBeNull();
      expect(disabled.platformModelConnectionId).toBeNull();
      await handlers.get("desktop:send")(undefined, { prompt: "research without a platform" });
      expect(engines.at(-1).requests.find(({ method }) => method === "session/run").params.model).toBe("test-model");
      expect(engines.at(-1).options.systemPrompt).not.toContain("我的材料平台");
      await handlers.get("desktop:set-edition")(undefined, "standard");
      await handlers.get("desktop:send")(undefined, { prompt: "pi research without a platform" });
      expect(requestedConnections.at(-1).model).toBe("test-model");
      expect(observed.at(-1).instructions).not.toContain("我的材料平台");
      expect((await service.state()).platforms).toHaveLength(1);
      await handlers.get("desktop:set-edition")(undefined, "full");
      await handlers.get("desktop:set-experience-mode")(undefined, "learning");
      await handlers.get("desktop:send")(undefined, { prompt: "学习任务" });
      expect(engines.at(-1).requests.find(({ method }) => method === "session/run").params.model).toBe("test-model");
      await handlers.get("desktop:set-edition")(undefined, "standard");
      await handlers.get("desktop:set-experience-mode")(undefined, "original");
      await handlers.get("desktop:send")(undefined, { prompt: "原版任务" });
      expect(requestedConnections.at(-1).model).toBe("test-model");
      expect((await handlers.get("desktop:state")()).platformModelConnectionId).toBeNull();
      expect((await handlers.get("desktop:state")()).activeResearchPlatform).toBeNull();
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).activeConnectionId).toBe(before.activeConnectionId);
    } finally {
      await handlers.get("desktop:set-edition")(undefined, "standard");
      writeFileSync(settingsPath, JSON.stringify(before));
    }
  });
});
