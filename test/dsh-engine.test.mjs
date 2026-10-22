import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { URL, pathToFileURL } from "node:url";

import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { ACTIVE_API_KEY_ENV, dshLauncherPath, dshProvider, dshRoute, fullEditionPrompt, prepareDshHome } from "../desktop/dsh-engine.mjs";

describe("BuildMe full edition engine helpers", () => {
  it("builds the full-edition prompt with DSH tool names instead of Build-mode tools", async () => {
    const prompt = await fullEditionPrompt(resolve("bundles/base/prompts"));
    expect(prompt).toContain("你是 BuildMe");
    expect(prompt).toContain("`web_search`");
    expect(prompt).toContain("`subagent`");
    expect(prompt).toContain("`document_read`");
    expect(prompt).not.toContain("`plan_manage`");
    expect(prompt).not.toContain("`skill_catalog`");
    expect(prompt).toContain("## 输出格式");
  });

  it("maps providers and locates the official dsh launcher", () => {
    expect(dshProvider("deepseek")).toBe("deepseek-official");
    expect(dshProvider("anthropic")).toBe("anthropic");
    expect(dshLauncherPath()).toMatch(/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/u);
  });

  it("routes connections: native DeepSeek, pi-ai catalog providers, and OpenAI-compatible relays", () => {
    const catalog = new Set(["deepseek", "anthropic", "openrouter"]);
    expect(dshRoute({ provider: "deepseek", model: "deepseek-v4-pro" }, catalog)).toEqual({ provider: "deepseek-official", model: "deepseek-v4-pro" });

    const claude = dshRoute({ provider: "anthropic", model: "claude-sonnet-5" }, catalog);
    expect(claude.provider).toBe("anthropic");
    expect(claude.piAiProviders.anthropic).toEqual({ apiKeyEnv: ACTIVE_API_KEY_ENV, models: [{ id: "claude-sonnet-5" }] });

    const proxied = dshRoute({ provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://relay.example/v1" }, catalog);
    expect(proxied).toMatchObject({ provider: "deepseek", piAiProviders: { deepseek: { baseURL: "https://relay.example/v1" } } });

    const relay = dshRoute({ provider: "openai-compatible", model: "vendor/model", baseUrl: "https://relay.example/v1" }, catalog);
    expect(relay.provider).toBe("buildme-relay");
    expect(relay.piAiProviders["buildme-relay"]).toMatchObject({ api: "openai-completions", baseURL: "https://relay.example/v1", apiKeyEnv: ACTIVE_API_KEY_ENV });
    expect(JSON.stringify(relay)).not.toMatch(/sk-/u);

    expect(() => dshRoute({ provider: "mystery", model: "m" }, catalog)).toThrow(/Base URL/u);
  });

  it("writes a dsh-base profile and an overlay with schedule, documents and the bridge", async () => {
    const home = await mkdtemp(join(tmpdir(), "buildme-dsh-"));
    try {
      const { profileDir, overlayPath } = await prepareDshHome({
        dshHome: home, bridgePath: "/app/dist/full/dsh-bridge.js", systemPrompt: "persona", timeZone: "Asia/Shanghai", workspacePath: join(home, "selected-workspace"),
      });
      const manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
      expect(manifest.dsh.profile.bundles).toEqual(["@deepseek-ai/dsh-base"]);
      const overlay = yaml.load(await readFile(overlayPath, "utf8"));
      expect(overlay[0]).toEqual({ id: "llm-pi-ai", config: { providers: {} } });
      expect(overlay[1]).toMatchObject({ id: "system-prompt", config: { personaPrefix: "persona" } });
      const inserted = overlay[2].insert.map((row) => row.id);
      expect(inserted).toEqual(["schedule", "time-context", "buildme-document-read", "buildme-platform", "buildme-bridge"]);
      expect(overlay[2].insert[1].config.timeZone).toBe("Asia/Shanghai");
      expect(overlay[2].insert[4].name).toBe(pathToFileURL(resolve("/app/dist/full/dsh-bridge.js")).href);
      expect(overlay[2].insert[3].name).toBe(pathToFileURL(resolve("/app/dist/full/dsh-platform-tool.js")).href);
      const skillConfig = overlay.find((row) => row.id === "skill-filesystem").config;
      expect(skillConfig).not.toHaveProperty("bundledSkillDir");
      expect(skillConfig.customSkillDirs).toContain(join(home, "selected-workspace", ".buildme", "skills"));
      expect(skillConfig.customSkillDirs.every((path) => !path.replaceAll("\\", "/").includes("bundles/research"))).toBe(true);
      // The user's own patch layer is created once and never overwritten.
      expect(await readFile(join(profileDir, "cordis.patch.yml"), "utf8")).toContain("[]");
      await prepareDshHome({ dshHome: home, bridgePath: "/app/dist/full/dsh-bridge.js", systemPrompt: "persona", processIsolated: true });
      const isolated = yaml.load(await readFile(overlayPath, "utf8"));
      expect(isolated.slice(-2)).toEqual([
        { id: "bash-sandbox", disabled: true },
        { insert: [{ id: "buildme-confined-bash", name: new URL("../desktop/dsh-confined-shell.mjs", import.meta.url).href, config: { timeoutMs: 60000 } }] },
      ]);
    } finally {
      expect(dirname(resolve(home))).toBe(resolve(tmpdir())); expect(basename(home)).toMatch(/^buildme-dsh-/u);
      await rm(home, { recursive: true, force: true });
    }
  });
});
