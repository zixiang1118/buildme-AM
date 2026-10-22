import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "buildme-module-electron-"));
const screenshots = resolve(process.env.BUILDME_MODULE_SCREENSHOTS || join(project, "artifacts", "research-modules"));

async function run(phase) {
  const env = { ...process.env, BUILDME_MODULE_SCREENSHOTS: screenshots }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts", "fixtures", "platform-modules-electron.cjs"), phase, root, project], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; if (String(data).includes("MODULES_")) process.stdout.write(data); });
  child.stderr.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    assert.equal(code, 0, output.slice(-12000));
    assert.ok(output.split("\n").some(line => line.startsWith("MODULES_SMOKE ")), output);
  } finally { clearTimeout(timeout); }
}

try {
  await Promise.all(["user-data", "app-data", "workspace"].map(directory => mkdir(join(root, directory))));
  await mkdir(screenshots, { recursive: true });
  await run("write"); await run("read");
  const result = JSON.parse(await readFile(join(root, "module-acceptance.json"), "utf8"));
  await writeFile(join(screenshots, "acceptance.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), isolatedUserData: true, noModelRequests: true, aiGenerationResponse: "fixture-only mocked response", ...result }, null, 2));
  console.log(`MODULES_SMOKE_OK Screenshots: ${screenshots}`);
} finally {
  const target = resolve(root);
  assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith("buildme-module-electron-"));
  await rm(target, { recursive: true, force: true });
}
