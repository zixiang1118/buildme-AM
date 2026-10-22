import { confineCompareCommand } from "../dist/core/compare-policy.js";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import * as yaml from "js-yaml";

/**
 * BuildMe full edition engine: runs the real DeepSeek Harness (dsh-base
 * profile) as a child process through the official `dsh` launcher and talks
 * to the BuildMe bridge plugin (dist/full/dsh-bridge.js) over stdio JSON-RPC.
 *
 * The child uses BuildMe's own DSH_HOME, so it never touches the user's ~/.dsh.
 */

const PROFILE_NAME = "buildme";
const STARTUP_TIMEOUT_MS = 90_000;

const require = createRequire(import.meta.url);

export function dshLauncherPath() {
  return join(dirname(require.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js");
}

/**
 * The agent persona shared with Build mode, with its tool section replaced
 * by the DSH tool names (read/glob/grep/web_search/subagent/workflow/...).
 */
export async function fullEditionPrompt(promptsDir) {
  const [base, tools] = await Promise.all([
    readFile(join(promptsDir, "buildme-agent.md"), "utf8"),
    readFile(join(promptsDir, "buildme-tools-dsh.md"), "utf8"),
  ]);
  const start = base.indexOf("## 工具使用");
  if (start < 0) return `${base.trim()}\n\n${tools.trim()}\n`;
  const next = base.indexOf("\n## ", start + 1);
  return `${base.slice(0, start)}${tools.trim()}\n${next < 0 ? "" : base.slice(next)}`;
}

/** Map a BuildMe (Pi catalog) provider id onto the DSH provider route. */
export function dshProvider(provider) {
  return provider === "deepseek" ? "deepseek-official" : provider;
}

/** Environment variable the DSH child reads the active connection's key from. */
export const ACTIVE_API_KEY_ENV = "BUILDME_ACTIVE_API_KEY";
const RELAY_ROUTE = "buildme-relay";

/**
 * Translate one BuildMe connection into the DSH route it runs on.
 *  - DeepSeek on its official endpoint → the native `deepseek-official` adapter.
 *  - Any other Pi-catalog provider (optionally with a Base URL override) → a
 *    `llm-pi-ai` route named after the provider.
 *  - `openai-compatible` relays and unknown providers → a hand-declared
 *    `buildme-relay` route speaking OpenAI Chat Completions.
 * Keys never enter the overlay: routes reference ACTIVE_API_KEY_ENV.
 *
 * @param {{ provider: string, model: string, baseUrl?: string }} connection
 * @param {ReadonlySet<string>} [catalogProviders] - Pi catalog provider ids.
 * @returns {{ provider: string, model: string, piAiProviders?: Record<string, object> }}
 */
export function dshRoute(connection, catalogProviders) {
  const { provider, model, baseUrl } = connection;
  if (provider === "deepseek" && !baseUrl) return { provider: "deepseek-official", model };
  const known = provider !== "openai-compatible" && (catalogProviders === undefined || catalogProviders.has(provider));
  if (known) {
    return {
      provider,
      model,
      piAiProviders: {
        [provider]: {
          apiKeyEnv: ACTIVE_API_KEY_ENV,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          // A model id newer than the bundled catalog still resolves on the provider's protocol.
          models: [{ id: model }],
        },
      },
    };
  }
  if (!baseUrl) throw new Error(`全量版无法识别 Provider「${provider}」，请填写 Base URL。`);
  return {
    provider: RELAY_ROUTE,
    model,
    piAiProviders: {
      [RELAY_ROUTE]: {
        displayName: "BuildMe 中转站",
        apiKeyEnv: ACTIVE_API_KEY_ENV,
        api: "openai-completions",
        baseURL: baseUrl,
        models: [{ id: model, name: model, input: ["text", "image"] }],
      },
    },
  };
}

async function writeIfChanged(path, content) {
  try {
    if ((await readFile(path, "utf8")) === content) return;
  } catch {
    // missing file
  }
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
}

/**
 * Write the BuildMe DSH profile and the BuildMe-owned overlay. The profile's
 * own cordis.patch.yml stays the user's layer; the overlay is regenerated on
 * every start so app updates take effect.
 */
export async function prepareDshHome({ dshHome, bridgePath, systemPrompt, timeZone, piAiProviders, workspacePath, processIsolated = false }) {
  const profileDir = join(dshHome, "profiles", PROFILE_NAME);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeIfChanged(join(profileDir, "package.json"), `${JSON.stringify({
    name: "buildme-full-profile",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" } },
  }, null, 2)}\n`);
  try {
    await readFile(join(profileDir, "cordis.patch.yml"), "utf8");
  } catch {
    await writeFile(join(profileDir, "cordis.patch.yml"), "# 你自己的 DSH 配置层（BuildMe 全量版）。\n[]\n", { encoding: "utf8", mode: 0o600 });
  }

  const overlay = [
    // The pi-ai multi-provider adapter is mounted dormant by dsh-base; BuildMe
    // supplies the active connection's route (empty keeps it dormant).
    { id: "llm-pi-ai", config: { providers: piAiProviders ?? {} } },
    {
      id: "system-prompt",
      config: {
        personaPrefix: systemPrompt,
        personaSuffix: "Your working directory is {{cwd}}.",
      },
    },
    {
      insert: [
        // Scheduled reminders: schedule_create / schedule_list / schedule_delete.
        // Due reminders arrive as follow-up messages in the same live session.
        { id: "schedule", name: "@deepseek-ai/dsh-schedule" },
        // A clock for the model so "明天上午九点" resolves in the user's time zone.
        {
          id: "time-context",
          name: "@deepseek-ai/dsh-time-context",
          config: { timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai", refreshIntervalMs: 600_000 },
        },
        // PDF (per page), Word .docx and HTML reading; DSH's own `read` is text-only.
        { id: "buildme-document-read", name: pathToFileURL(join(dirname(bridgePath), "dsh-document-tool.js")).href },
        { id: "buildme-platform", name: pathToFileURL(join(dirname(bridgePath), "dsh-platform-tool.js")).href },
        { id: "buildme-bridge", name: pathToFileURL(bridgePath).href },
      ],
    },
  ];
  overlay.push({ id: "skill-filesystem", config: { customSkillDirs: [...(workspacePath ? [join(workspacePath, ".buildme", "skills")] : []), join(homedir(), ".buildme", "skills")] } });
  if (processIsolated) overlay.push(
    { id: "bash-sandbox", disabled: true },
    { insert: [{ id: "buildme-confined-bash", name: new URL("./dsh-confined-shell.mjs", import.meta.url).href, config: { timeoutMs: 60000 } }] },
  );
  const overlayPath = join(dshHome, "buildme-overlay.patch.yml");
  await writeIfChanged(overlayPath, yaml.dump(overlay, { lineWidth: -1, noRefs: true }));
  return { profileDir, overlayPath };
}

export class DshEngine {
  /**
   * @param {object} options
   * @param {string} options.dshHome - BuildMe-owned DSH_HOME.
   * @param {string} options.bridgePath - absolute path of dist/full/dsh-bridge.js.
   * @param {string} options.systemPrompt - persona text for the DSH system prompt.
   * @param {string} options.cwd - process working directory (default workspace).
   * @param {Record<string, string>} [options.env] - extra environment (API keys, proxy).
   * @param {Record<string, object>} [options.piAiProviders] - `llm-pi-ai` routes for non-DeepSeek connections.
   * @param {string} [options.nodePath] - node binary; Electron passes process.execPath.
   * @param {string} [options.launcherPath] - dsh launcher; defaults to the installed @deepseek-ai/dsh.
   * @param {(event: object) => void} [options.onStream]
   * @param {(event: { sessionId: string, status: string }) => void} [options.onStatus]
   * @param {(request: object) => Promise<boolean>} [options.onApproval]
   * @param {(line: string) => void} [options.onLog]
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.transport = undefined;
    this.ready = undefined;
    this.stderrTail = [];
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  start() {
    this.ready ??= this.launch().catch((error) => {
      this.ready = undefined;
      this.kill();
      throw error;
    });
    return this.ready;
  }

  async launch() {
    const { dshHome, bridgePath, systemPrompt, cwd, piAiProviders } = this.options;
    const { overlayPath } = await prepareDshHome({ dshHome, bridgePath, systemPrompt, piAiProviders, workspacePath: cwd, processIsolated: Boolean(this.options.isolationRoot) });
    if (this.options.isolationRoot) await mkdir(join(this.options.isolationRoot, "temp"), { recursive: true, mode: 0o700 });
    const nodePath = this.options.nodePath ?? process.execPath;
    const launcher = this.options.launcherPath ?? dshLauncherPath();
    const argv = [nodePath, launcher, "--profile", PROFILE_NAME, "--patch", overlayPath];
    const confined = this.options.isolationRoot ? confineCompareCommand(argv, this.options.isolationRoot) : argv;
    const child = spawn(confined[0], confined.slice(1), {
      cwd,
      env: {
        ...process.env,
        ...this.options.env,
        ELECTRON_RUN_AS_NODE: "1",
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: "1",
        NODE_USE_ENV_PROXY: "1",
        ...(this.options.isolationRoot ? { BUILDME_COMPARE_ISOLATION_ROOT: this.options.isolationRoot, TMPDIR: join(this.options.isolationRoot, "temp"), TMP: join(this.options.isolationRoot, "temp"), TEMP: join(this.options.isolationRoot, "temp") } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      for (const line of String(text).split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        this.options.onLog?.(line);
      }
    });

    const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    this.transport = transport;
    transport.onNotification((method, params) => {
      if (method === "stream") this.options.onStream?.(params);
      else if (method === "status") this.options.onStatus?.(params);
      else if (method === "trace") this.options.onTrace?.(params);
    });
    transport.onRequest(async (method, params) => {
      if (method !== "approval/request") throw new Error(`unknown BuildMe desktop method: ${method}`);
      const answer = await this.options.onApproval?.(params);
      return typeof answer === "object" ? { allow: false, ...answer } : { allow: answer === true };
    });
    transport.start();

    const exited = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.transport?.close();
        this.transport = undefined;
        this.ready = undefined;
        reject(new Error(`DSH 引擎已退出（${signal ?? code}）：${this.stderrTail.slice(-5).join(" | ") || "无输出"}`));
      });
    });
    exited.catch(() => undefined);

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("DSH 引擎启动超时。")), STARTUP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([transport.request("initialize", {}), exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, params = {}) {
    await this.start();
    if (!this.transport) throw new Error("DSH 引擎未运行。");
    return this.transport.request(method, params);
  }

  kill() {
    const child = this.child;
    this.child = undefined;
    this.transport?.close();
    this.transport = undefined;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  /** Close stdin so the bridge disposes the DSH tree, then force-kill after a grace period. */
  async stop(graceMs = 5000) {
    const child = this.child;
    this.ready = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    await exited;
    clearTimeout(timer);
    this.child = undefined;
    this.transport = undefined;
  }
}
