import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryParent = resolve(tmpdir());
const root = await mkdtemp(join(temporaryParent, "buildme-experiences-electron-"));
const userData = join(root, "user-data");
const screenshots = resolve(process.env.BUILDME_EXPERIENCE_SCREENSHOTS || join(project, "artifacts", "experiences"));

async function runPhase(phase) {
  const env = { ...process.env, BUILDME_EXPERIENCE_SCREENSHOTS: screenshots };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts", "fixtures", "experiences-electron.cjs"), phase, root, project], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
    if (String(data).includes("EXPERIENCES_PROGRESS")) process.stdout.write(data);
  });
  child.stderr.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    assert.equal(code, 0, output);
    const result = output.split("\n").find((line) => line.startsWith("EXPERIENCES_SMOKE "));
    assert.ok(result, output);
    console.log(result);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await mkdir(userData);
  await mkdir(join(root, "app-data"));
  await mkdir(join(root, "workspace"));
  await mkdir(screenshots, { recursive: true });
  await writeFile(join(userData, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    settings: {
      name: "BuildMe", home: join(userData, "sessions-home"),
      agent: { provider: "faux", model: "caps", systemPrompt: await readFile(join(project, "bundles", "base", "prompts", "buildme-agent.md"), "utf8") },
    },
    plugins: [
      { id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" },
      { id: "smoke.model", source: join(project, "scripts", "fixtures", "capabilities-faux.mjs") },
      { id: "prompt.personal" }, { id: "tool.workspace-info" }, { id: "tool.workspace-tools-pi" },
      { id: "tool.document-tools" }, { id: "tool.full-edition-tools" }, { id: "runtime.pi" },
    ],
  }));
  await writeFile(join(userData, "desktop-settings.json"), JSON.stringify({
    connections: [{ id: "smoke", name: "本地假模型", provider: "faux", model: "caps", baseUrl: "https://example.invalid/v1" }],
    activeConnectionId: "smoke", workspacePath: join(root, "workspace"), permissionMode: "bypass",
    edition: "standard", experienceMode: "original", capabilities: ["core"], theme: "dark",
  }));
  await runPhase("write");
  await runPhase("read");
  console.log(`Experience screenshots: ${screenshots}`);
} finally {
  const target = resolve(root);
  assert.equal(dirname(target), temporaryParent, "Cleanup target must be a direct child of the temporary directory.");
  assert.ok(basename(target).startsWith("buildme-experiences-electron-"), "Cleanup target must be this verifier's temporary directory.");
  await rm(target, { recursive: true, force: true });
}
