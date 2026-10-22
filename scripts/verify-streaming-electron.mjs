import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, "buildme-streaming-electron-"));
const artifacts = join(project, "artifacts", "streaming");
try {
  await Promise.all(["user-data", "app-data", "workspace"].map(directory => mkdir(join(root, directory))));
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(root, "user-data", "desktop-settings.json"), JSON.stringify({
    connections: [{ id: "fixture", provider: "openai-compatible", model: "local-stream-fixture", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local-fixture-only" }],
    activeConnectionId: "fixture", edition: "standard", experienceMode: "original", workspacePath: join(root, "workspace"), permissionMode: "ask", capabilities: ["core"], theme: "dark",
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts", "fixtures", "streaming-electron.cjs"), root, project, artifacts], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; if (String(data).includes("STREAMING_")) process.stdout.write(data); });
  child.stderr.on("data", data => { output += data; if (/SyntaxError|App threw an error/u.test(String(data))) child.kill(); });
  const timeout = setTimeout(() => child.kill(), 180000);
  try {
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    assert.equal(code, 0, output.slice(-16000));
  } finally { clearTimeout(timeout); }
  const report = JSON.parse(await readFile(join(artifacts, "acceptance.json"), "utf8"));
  assert.ok(report.characters >= 100000); assert.ok(report.chunks >= 2000);
  console.log(`STREAMING_SMOKE_OK ${artifacts}`);
} finally {
  const target = resolve(root); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith("buildme-streaming-electron-"));
  await rm(target, { recursive: true, force: true });
}
