import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electron from "electron";

const project = resolve("."), root = await mkdtemp(join(tmpdir(), "buildme-compare-packages-"));
const require = createRequire(import.meta.url);
const { createPackage } = createRequire(require.resolve("@electron/packager"))("@electron/asar");
try {
  const workspace = join(root, "workspace"), contents = join(root, "archive-source");
  const resources = join(workspace, "release/BuildMe.app/Contents/Resources");
  await mkdir(resources, { recursive: true });
  await mkdir(contents);
  await writeFile(join(contents, "package.json"), "{}");
  await writeFile(join(workspace, "input.txt"), "baseline\n");
  await writeFile(join(workspace, "release/notes.md"), "release notes\n");
  await createPackage(contents, join(resources, "app.asar"));
  await createPackage(contents, join(workspace, "release/app.asar"));
  await mkdir(join(workspace, "release/app.asar.unpacked"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts/fixtures/compare-packaged-workspace.cjs"), root, process.env.BUILDME_COMPARE_APPLICATION_ROOT || project, process.env.BUILDME_COMPARE_WORKSPACE || workspace], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill(), 120000);
  try {
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
    assert.equal(code, 0, output);
    const result = output.split("\n").find(line => line.startsWith("COMPARE_PACKAGES "));
    assert.ok(result, output); console.log(result);
  } finally { clearTimeout(timer); }
} finally { await rm(root, { recursive: true, force: true }); }
