import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "buildme-permission-electron-"));
const screenshots = join(project, "artifacts", "permission-menu"), probe = process.argv.includes("--probe");
async function phase(name) {
  console.log(`PERMISSION_PROGRESS ${name} boot`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts", "fixtures", "permission-menu-electron.cjs"), name, root, project, screenshots], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; if (String(data).includes("PERMISSION_")) process.stdout.write(data); });
  child.stderr.on("data", data => { output += data; if (/SyntaxError|App threw an error/u.test(String(data))) child.kill(); });
  const timeout = setTimeout(() => child.kill(), 120000);
  try { const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); }); assert.equal(code, 0, output.slice(-14000)); }
  finally { clearTimeout(timeout); }
}
try {
  await Promise.all(["user-data", "app-data", "workspace"].map(directory => mkdir(join(root, directory)))); await mkdir(screenshots, { recursive: true });
  await writeFile(join(root, "user-data", "desktop-settings.json"), JSON.stringify({
    connections: [{ id: "fixture", provider: "openai-compatible", model: "local-fixture", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local-fixture-only" }],
    activeConnectionId: "fixture", edition: "standard", experienceMode: "original", permissionMode: "ask", capabilities: ["core"], theme: "dark",
  }));
  if (probe) await phase("probe");
  else {
    await phase("write"); await phase("read");
    const results = JSON.parse(await readFile(join(root, "permission-acceptance.json"), "utf8"));
    await writeFile(join(screenshots, "acceptance.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), realElectron: true, modelRequests: 0, ...results,
      checks: ["native mouse opens popup", "all three options visible and clickable", "real backend selection", "selection survives restart", "dark and light themes", "research and original experience", "narrow viewport and horizontal context scroll", "workspace wording and directory dialog", "Escape and outside click dismiss popup"],
    }, null, 2));
    console.log(`PERMISSION_SMOKE_OK ${screenshots}`);
  }
} finally {
  const target = resolve(root); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith("buildme-permission-electron-"));
  await rm(target, { recursive: true, force: true });
}
