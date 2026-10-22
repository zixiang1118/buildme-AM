const { app } = require("electron");
const assert = require("node:assert/strict");
const { readFile, lstat } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const [, , root, applicationRoot, workspace] = process.argv;
app.setPath("userData", join(root, "user-data"));
app.whenReady().then(async () => {
  const archive = join(root, "workspace/release/app.asar");
  assert.equal((await lstat(archive)).isDirectory(), true, "reproduce Electron's virtual ASAR filesystem");
  const { createCompareService } = await import(pathToFileURL(join(applicationRoot, "desktop/compare.mjs")));
  const service = createCompareService({ root: join(root, "comparisons"), applicationRoot,
    config: async () => ({ workspacePath: workspace, connections: [{ id: "local", provider: "openai-compatible", model: "unused" }], activeConnectionId: "local", capabilities: ["core"] }),
    notify() {}, learning: async () => {},
  });
  try {
    const group = await service.create({ kind: "harness" });
    assert.notEqual(group.sides.left.sessionId, group.sides.right.sessionId);
    if (workspace === join(root, "workspace")) {
      assert.deepEqual(group.workspace.excluded, ["release/BuildMe.app", "release/app.asar", "release/app.asar.unpacked"]);
      assert.deepEqual(Object.keys(group.workspace.files).sort(), ["input.txt", "release/notes.md"]);
      for (const side of ["left", "right"]) assert.equal(await readFile(join(root, "comparisons/workspaces", group.id, side, "workspace/input.txt"), "utf8"), "baseline\n");
      assert.equal(await readFile(join(workspace, "input.txt"), "utf8"), "baseline\n");
    } else assert.ok(group.workspace.excluded.some(path => path.endsWith("BuildMe.app")));
    assert.equal((await service.details(group.id)).group.rounds.length, 0);
    console.log("COMPARE_PACKAGES " + JSON.stringify({ created: true, files: Object.keys(group.workspace.files).length, excludedApplications: group.workspace.excluded.filter(path => /\.(app|asar|asar\.unpacked)$/.test(path)), realApi: false }));
  } finally { await service.close(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
