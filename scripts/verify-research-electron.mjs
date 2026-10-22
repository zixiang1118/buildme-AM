import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import electron from "electron";

const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, "buildme-research-smoke-"));
const screenshots = join(project, "artifacts", "research");
await mkdir(join(root, "user-data"));
await mkdir(join(root, "app-data"));
await mkdir(join(root, "workspace"));
await mkdir(join(root, "exports"));
await mkdir(screenshots, { recursive: true });
await writeFile(join(root, "assay.csv"), "sampleId,concentration,value,replicate,group\na,1,10,1,A\na,1,14,2,A\nb,1,20,1,A\nc,2,30,1,A\nd,2,,1,A\n");
await writeFile(join(root, "molecules.smi"), "CCN 仅用于导入测试\ninvalid-smiles\n");
await writeFile(join(root, "user-data", "desktop-settings.json"), JSON.stringify({ connections: [], edition: "standard", experienceMode: "original", workspacePath: join(root, "workspace"), permissionMode: "ask", capabilities: ["core"], theme: "dark" }));
async function run(phase) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(project, "scripts", "fixtures", "research-electron.cjs"), phase, root, project, "--research"], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; if (String(data).includes("RESEARCH_")) process.stdout.write(data); });
  child.stderr.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill(), process.env.BUILDME_VERIFY_RETROSYNTHESIS === "1" ? 300000 : 150000);
  try {
    const code = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    assert.equal(code, 0, output.slice(-20000));
  } finally { clearTimeout(timer); }
}
try {
  await run("write");
  await run("read");
  const exported = JSON.parse(await readFile(join(root, "export-result.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(exported.path, "manifest.json"), "utf8"));
  assert.ok(manifest.project.title.includes("桌面科研验收"));
  await writeFile(join(screenshots, process.env.BUILDME_VERIFY_RETROSYNTHESIS === "1" ? "desktop-acceptance.json" : "desktop-acceptance-basic.json"), JSON.stringify({
    verifiedAt: new Date().toISOString(), isolatedSoftwareFixture: true,
    workflows: ["project creation", "real RDKit calculation", "molecule file import", "plan and batch linkage", "CSV import with missing values", "sample-level descriptive analysis", "archived file opening or location", "evidence-linked drafts", "portable export with original files", "restart recovery", "compact layout", "original / learning / research version switching"],
    retrosynthesis: manifest.analyses.filter(item => item.provenance === "predicted" && item.result?.runId).map(item => ({
      runId: item.result.runId, evidence: item.result.evidence, runBudget: item.result.runBudget,
      exportedTrees: item.result.routes.length, explicitlySolvedTrees: item.result.routes.filter(tree => tree.metadata?.is_solved === true).length,
      engineSummary: item.result.routeSummary, archivedFiles: item.assetIds.length,
    })),
  }, null, 2));
  console.log(`RESEARCH_SMOKE_OK Screenshots: ${screenshots}`);
} finally {
  assert.equal(dirname(resolve(root)), parent);
  assert.ok(basename(root).startsWith("buildme-research-smoke-"));
  await rm(root, { recursive: true, force: true });
}
