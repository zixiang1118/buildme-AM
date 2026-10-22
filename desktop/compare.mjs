import { join } from "node:path";
import { CompareWorkspace } from "../dist/core/compare-workspace.js";
import { CompareCoordinator, comparisonPrompt, READING_STRATEGIES } from "../dist/core/compare-coordinator.js";
import { compareMetrics, metricDifference } from "../dist/core/compare-metrics.js";
import { ALL_CAPABILITIES, resolveCapabilities } from "../dist/core/capabilities.js";
import { DshEngine, dshRoute, fullEditionPrompt, ACTIVE_API_KEY_ENV } from "./dsh-engine.mjs";

export function createCompareService({ root, applicationRoot, config, keyFor, runtime, service, traceStore, onTrace, approval, notify, learning }) {
  const workspaces = new CompareWorkspace(join(root, "workspaces"));
  const engines = new Map(), sessions = new Map(), turns = new Map();
  const coordinator = new CompareCoordinator(join(root, "groups"), workspaces, {
    async run(group, side, round, signal, stream) {
      const settings = group.sides[side], snapshot = settings.connection, current = await config();
      const saved = current.connections.find((c) => c.id === snapshot.id);
      if (!saved) throw new Error("此对比使用的模型连接已删除，请恢复该连接或新建对比。");
      if (saved.provider !== snapshot.provider || saved.baseUrl !== snapshot.baseUrl) throw new Error("此连接的服务地址已变化，请新建对比，避免向旧地址发送新凭据。");
      const connection = { ...snapshot, ...(keyFor(saved) ? { apiKey: keyFor(saved) } : {}) };
      const workspace = workspaces.path(group.id, side);
      const source = `${side === "left" ? "左侧" : "右侧"} · ${settings.engine === "pi" ? "Pi" : "DSH"} · ${snapshot.model}`;
      sessions.set(settings.sessionId, { groupId: group.id, source });
      const comparePolicy = { workspaceRoot: workspace, readOnly: group.workspace.readOnly };
      signal.throwIfAborted();
      if (settings.engine === "pi") {
        const app = await runtime(); signal.throwIfAborted();
        const stop = app.ctx.on("piharness/agent-event", (id, event) => {
          if (id !== settings.sessionId) return;
          if (event.type === "message_start" && event.message.role === "assistant") stream("", "response-start");
          if (event.type === "message_update" && ["text_delta", "thinking_delta"].includes(event.assistantMessageEvent.type)) stream(event.assistantMessageEvent.delta, event.assistantMessageEvent.type === "thinking_delta" ? "reasoning" : "text");
        });
        const agents = service(app, "agents"), sessionStore = service(app, "sessions");
        const handle = await sessionStore.exists(settings.sessionId) ? await agents.resume({ resumeSessionId: settings.sessionId }) : await agents.create({ sessionId: settings.sessionId });
        try {
          return await handle.agent.send(comparisonPrompt(group.kind, side, round.prompt), { connection, workspacePath: workspace, permissionMode: "bypass", edition: "full", capabilities: settings.capabilities, compareGroupId: group.id, comparePolicy, recordRawRequests: current.recordRawRequests, signal });
        } finally { stop(); await handle.dispose(); await traceStore().flush(); }
      }
      const route = dshRoute(connection);
      const engineKey = `${group.id}:${side}`;
      let engine = engines.get(engineKey);
      if (!engine) {
        engine = new DshEngine({
          dshHome: join(workspaces.sideRoot(group.id, side), "engine"), isolationRoot: workspaces.sideRoot(group.id, side),
          bridgePath: join(applicationRoot, "dist/full/dsh-bridge.js"), systemPrompt: `${await fullEditionPrompt(join(applicationRoot, "bundles/base/prompts"))}\n\n对比任务在独立工作区副本中运行。只能在当前副本内写入；禁止提权和后台命令。调用 subagent / subagent_fork 必须显式设置 run_in_background: false。${group.workspace.readOnly ? "当前副本强制只读，禁止写入和命令执行。" : ""}`,
          cwd: workspace, nodePath: process.execPath, piAiProviders: route.piAiProviders,
          env: { [ACTIVE_API_KEY_ENV]: connection.apiKey ?? "", DEEPSEEK_API_KEY: saved.provider === "deepseek" ? connection.apiKey ?? "" : "" },
          onStream: (event) => { if (["text", "reasoning", "response-start"].includes(event.type)) stream(event.delta ?? "", event.type); }, onTrace,
          onApproval: (request) => approval({ ...request, source, compareGroupId: group.id, permissionMode: "bypass" }),
          onLog: (line) => { if (!line.includes("reasoning")) console.error(`[对比 DSH] ${line}`); },
        });
        engines.set(engineKey, engine);
      }
      engine.options.onStream = (event) => { if (["text", "reasoning", "response-start"].includes(event.type)) stream(event.delta ?? "", event.type); };
      await engine.start(); signal.throwIfAborted();
      const cancel = () => { void engine.request("session/cancel", { sessionId: settings.sessionId }); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const known = await engine.request("session/list"); signal.throwIfAborted();
        const result = await engine.request("session/run", { sessionId: settings.sessionId, createSession: !known.some((s) => s.id === settings.sessionId), ...route, text: round.prompt, cwd: workspace, permissionMode: "bypass", compareGroupId: group.id, comparePolicy, recordRawRequests: current.recordRawRequests });
        if (result.reason !== "completed" && result.reason !== "max-tokens" && result.reason !== "aborted") throw new Error(result.error || `DSH：${result.reason}`);
        return { text: result.text, cancelled: result.reason === "aborted" };
      } finally { signal.removeEventListener("abort", cancel); await traceStore().flush(); }
    },
  }, notify, async (compareGroupId, turnId) => learning({ id: `compare:${compareGroupId}`, at: new Date().toISOString(), type: "compare-completed", compareGroupId, ...(turnId ? { turnId } : {}) }));
  let cleanupPending;
  const cleanup = () => cleanupPending ??= (async () => {
    for (const group of await coordinator.list()) if (!group.workspace.expired && Date.now() - Date.parse(group.createdAt) >= 7 * 86400_000) {
      await coordinator.stop(group.id);
      for (const side of ["left", "right"]) { const id = `${group.id}:${side}`, engine = engines.get(id); if (engine) { await engine.stop(); engines.delete(id); } }
      await coordinator.expire(group.id);
    }
  })().finally(() => { cleanupPending = undefined; });
  const timer = setInterval(() => { void cleanup().catch((error) => console.warn(`[对比] 副本清理失败：${error.message}`)); }, 60000);
  timer.unref();
  const details = async (id) => {
    await cleanup();
    const group = await coordinator.get(id);
    const round = group.rounds.at(-1);
    const traces = {}, metrics = {};
    if (round) for (const side of ["left", "right"]) {
      const run = round.runs[side]; traces[side] = await Promise.all(run.turnIds.map((id) => traceStore().turn(id)));
      metrics[side] = compareMetrics(traces[side], run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined, group.differences[side]?.changes.length);
    }
    const differences = {};
    if (round) for (const key of ["modelCalls", "toolCalls", "subagents", "compactions", "tokens", "durationMs", "files"]) differences[key] = metricDifference(metrics.left[key], metrics.right[key]);
    return { group, traces, metrics, differences, ...(group.kind === "reading" ? { strategies: READING_STRATEGIES } : {}) };
  };
  return {
    coordinator, details,
    list: async () => { await cleanup(); return coordinator.list(); },
    ownsSession: (id) => sessions.has(id), source: (id) => sessions.get(id),
    trace: (notification) => {
      coordinator.trace(notification);
      if (notification.type === "turn-start") {
        const turn = notification.turn, source = sessions.get(turn.sessionId) ?? turns.get(turn.parentTurnId);
        if (source) { sessions.set(turn.sessionId, source); turns.set(turn.id, source); }
      }
    },
    async create(payload) {
      const saved = await config();
      if (!saved.workspacePath) throw new Error("请先选择工作区，再开始对比。");
      if (!["harness", "model", "reading"].includes(payload?.kind)) throw new Error("请选择对比类型。");
      if (payload.kind === "model" && (!payload.leftConnectionId || !payload.rightConnectionId || payload.leftConnectionId === payload.rightConnectionId)) throw new Error("模型对比需要明确选择两条模型连接。");
      const chosen = (id) => {
        const c = saved.connections.find((item) => item.id === id); if (!c) throw new Error("模型连接不存在。");
        return { id: c.id, name: c.name, provider: c.provider, model: c.model, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) };
      };
      let capabilities = payload.piAll === true ? ALL_CAPABILITIES : saved.capabilities ?? ["core"];
      if (payload.kind === "reading") capabilities = resolveCapabilities([...capabilities, "search"]);
      const left = chosen(payload.leftConnectionId || saved.activeConnectionId), right = payload.kind === "model" ? chosen(payload.rightConnectionId) : left;
      return coordinator.create({ kind: payload.kind, workspace: saved.workspacePath, left: { engine: "pi", connection: left, capabilities }, right: { engine: payload.kind === "harness" ? "dsh" : "pi", connection: right, capabilities } });
    },
    async adopt(id, side, token) {
      const group = await coordinator.get(id);
      if (Object.values(group.rounds.at(-1)?.runs ?? {}).some((run) => run.status === "running")) throw new Error("请等待两侧停止后再采用改动。");
      if (!["left", "right"].includes(side) || typeof token !== "string") throw new Error("采用参数不正确。");
      return workspaces.adopt(id, side, token);
    },
    async remove(id) {
      await coordinator.stop(id);
      for (const side of ["left", "right"]) { const key = `${id}:${side}`, engine = engines.get(key); if (engine) { await engine.stop(); engines.delete(key); } }
      await coordinator.remove(id);
    },
    async close() { clearInterval(timer); await cleanupPending; await coordinator.close(); await Promise.all([...engines.values()].map((engine) => engine.stop())); },
  };
}
