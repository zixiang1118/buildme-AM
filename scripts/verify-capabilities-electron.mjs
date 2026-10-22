import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electron from "electron";
import { fileURLToPath } from "node:url";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "buildme-capabilities-electron-"));
const userData = join(root, "user-data");
try {
  await mkdir(userData); await mkdir(join(root, "app-data")); await mkdir(join(root, "workspace"));
  await writeFile(join(userData, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    settings: { name: "BuildMe", home: join(userData, "sessions-home"), agent: { provider: "faux", model: "caps", systemPrompt: await readFile(join(project, "bundles/base/prompts/buildme-agent.md"), "utf8") } },
    plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "smoke.model", source: join(project, "scripts/fixtures/capabilities-faux.mjs") }, { id: "prompt.personal" }, { id: "tool.workspace-info" }, { id: "tool.workspace-tools-pi" }, { id: "tool.document-tools" }, { id: "tool.full-edition-tools" }, { id: "runtime.pi" }],
  }));
  await writeFile(join(userData, "desktop-settings.json"), JSON.stringify({
    connections: [{ id: "smoke", name: "本地假模型", provider: "faux", model: "caps", baseUrl: "https://example.invalid/v1" }],
    activeConnectionId: "smoke", workspacePath: join(root, "workspace"), permissionMode: "bypass", edition: "standard",
  }));
  for (const phase of ["write", "read"]) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [join(project, "scripts/fixtures/capabilities-electron.cjs"), phase, root, project], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
    const timeout = setTimeout(() => child.kill(), 45000);
    try {
      const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
      assert.equal(code, 0, output);
      const result = output.split("\n").find((line) => line.startsWith("CAPABILITIES_SMOKE "));
      assert.ok(result, output); console.log(result);
    } finally { clearTimeout(timeout); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
