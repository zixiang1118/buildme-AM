import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, "buildme-platforms-electron-"));
const screenshots = resolve(process.env.BUILDME_PLATFORM_SCREENSHOTS || join(project, "artifacts", "platforms"));

async function runPhase(phase) {
  const env = { ...process.env, BUILDME_PLATFORM_SCREENSHOTS: screenshots };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts", "fixtures", "platforms-electron.cjs"), phase, root, project], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; if (String(data).includes("PLATFORMS_")) process.stdout.write(data); });
  child.stderr.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill(), 120000);
  try {
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    assert.equal(code, 0, output.slice(-16000));
    assert.ok(output.split("\n").some((line) => line.startsWith("PLATFORMS_SMOKE ")), output);
  } finally { clearTimeout(timeout); }
}

try {
  await Promise.all(["user-data", "app-data", "workspace", "exports"].map((directory) => mkdir(join(root, directory))));
  await mkdir(screenshots, { recursive: true });
  await writeFile(join(root, "measurements.csv"), "样品编号,组别,读数,备注\r\na,A,10,初次\r\na,A,14,技术重复\r\nb,A,20,\r\nc,A,30,\r\nd,A,,缺失读数\r\n");
  await writeFile(join(root, "user-data", "desktop-settings.json"), JSON.stringify({
    connections: [], edition: "standard", experienceMode: "original", workspacePath: join(root, "workspace"), permissionMode: "ask", capabilities: ["core"], theme: "dark",
  }));
  await runPhase("write");
  await runPhase("read");
  const fixture = JSON.parse(await readFile(join(root, "platform-acceptance.json"), "utf8"));
  const exported = JSON.parse(await readFile(join(fixture.exportPath, "snapshot.json"), "utf8"));
  assert.equal(exported.definition.id, fixture.platformId);
  assert.ok(exported.assets.length >= 2);
  assert.ok(exported.runs.some((run) => run.kind === "workflow" && run.status === "completed"));
  const template = JSON.parse(await readFile(join(root, "platform-template.json"), "utf8"));
  assert.equal(template.format, "buildme-platform-template-v1");
  assert.equal(template.definition.id, undefined);
  assert.equal(template.records, undefined);
  assert.equal(template.assets, undefined);
  assert.equal(template.runs, undefined);
  await writeFile(join(screenshots, "desktop-acceptance.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), isolatedUserData: true, noModelRequests: true,
    checks: ["three version switching and research-only entry", "research entry directly before header settings", "current platform name after create, rename, import, select and restart", "full current platform name tooltip", "long conversation and platform names with header actions at 1400px and 900px", "Chinese platform building and usage guide", "guide navigation and close focus restoration", "dark and light header and guide layouts", "describe and modify preview", "real UI platform creation", "custom records", "CSV field mapping and raw evidence", "sample-level statistics and missing data", "workflow execution and report", "configuration versions preserving data", "template contains configuration only", "portable original-file export", "restart recovery", "compact layout"],
    summary: { definitionVersion: fixture.definitionVersion, records: fixture.records, runs: fixture.runs, assets: fixture.assets },
  }, null, 2));
  console.log(`PLATFORMS_SMOKE_OK Screenshots: ${screenshots}`);
} finally {
  const target = resolve(root);
  assert.equal(dirname(target), parent, "Cleanup must stay in the temporary directory.");
  assert.ok(basename(target).startsWith("buildme-platforms-electron-"), "Cleanup must target this fixture.");
  await rm(target, { recursive: true, force: true });
}
