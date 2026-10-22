import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confineCompareCommand } from "../dist/core/compare-policy.js";
const root = await mkdtemp(join(tmpdir(), "buildme-sandbox-"));
try {
  const copy = join(root, "copy"), outside = join(root, "original.txt"); await mkdir(copy); await writeFile(outside, "untouched");
  const argv = confineCompareCommand([process.execPath, "-e", "const fs=require('node:fs');fs.writeFileSync('inside.txt','okay');try {fs.writeFileSync(process.argv[1],'escaped');process.exit(7)} catch { process.exit(0) }", outside], copy);
  const result = spawnSync(argv[0], argv.slice(1), { cwd: copy, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(await readFile(outside, "utf8"), "untouched"); assert.equal(await readFile(join(copy, "inside.txt"), "utf8"), "okay");
  console.log(JSON.stringify({ platform: process.platform, actualSandbox: true, insideWrite: true, outsideTempWriteDenied: true }));
} finally { await rm(root, { recursive: true, force: true }); }
