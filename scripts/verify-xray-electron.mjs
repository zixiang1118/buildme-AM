import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "buildme-xray-electron-"));
const userData = join(root, "user-data");
const fakeKey = "sk-test-AAAAAAAAAAAAAAAAAAAA";

async function runPhase(phase) {
  const env = { ...process.env, DEEPSEEK_API_KEY: fakeKey };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts/fixtures/xray-electron.cjs"), phase, root, project], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    assert.equal(code, 0, output);
    const result = output.split("\n").find((line) => line.startsWith("XRAY_SMOKE "));
    assert.ok(result, output);
    console.log(result);
  } finally { clearTimeout(timeout); }
}

try {
  await mkdir(userData);
  await mkdir(join(root, "app-data"));
  await writeFile(join(userData, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    settings: { name: "BuildMe X 光验收", home: join(userData, "sessions-home"), agent: { provider: "faux", model: "faux-1", systemPrompt: "local verification", toolExecution: "parallel" } },
    plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "smoke.model", source: join(project, "scripts/fixtures/xray-faux.mjs") }, { id: "runtime.pi" }],
  }));
  await writeFile(join(userData, "desktop-settings.json"), JSON.stringify({
    connections: [{ id: "smoke", name: "本地假模型", provider: "faux", model: "faux-1", baseUrl: "https://example.invalid/v1" }],
    activeConnectionId: "smoke", permissionMode: "bypass", edition: "standard", recordRawRequests: true,
  }));
  await runPhase("write");
  await runPhase("read");
} finally { await rm(root, { recursive: true, force: true }); }
