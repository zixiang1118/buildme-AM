const { app, dialog } = require("electron");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const [, , phase, root, project] = process.argv;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(root, "learning-export.json") });
app.setPath("userData", join(root, "user-data")); app.setPath("appData", join(root, "app-data"));
app.on("browser-window-created", (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once("did-finish-load", () => void verify(window).catch((error) => { console.error(error); app.exit(1); }));
});
async function verify(window) {
  const js = (code) => window.webContents.executeJavaScript(code);
  await js(`window.waitForUI = (predicate) => new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('UI timeout: ' + predicate)); }, 10000);
    const observer = new MutationObserver(() => { if (predicate()) { clearTimeout(timeout); observer.disconnect(); resolve(); } });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }); window.nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); void 0;`);
  if (phase === "write") {
    await js("waitForUI(() => document.querySelector('#capability-onboarding').open)");
    await js("document.querySelector('#capability-choose-minimal').click(); waitForUI(() => !document.querySelector('#capability-onboarding').open)");
    assert.deepEqual((await js("window.personalAgent.state()")).capabilities, ["core"]);
    await js(`window.turns = []; window.personalAgent.onXray(n => { if (n.type === 'turn-end') turns.push(n.turn); });
      document.querySelector('#prompt').value = '检查工作区'; document.querySelector('#composer').requestSubmit();
      waitForUI(() => document.querySelector('#send').dataset.running === 'false' && document.querySelector('.xray-stats'))`);
    const first = await js("turns[0]");
    assert.deepEqual(first.capabilities, ["core"]);
    assert.ok(!first.events.find((e) => e.type === "llm.request").toolNames.includes("skill_load"));
    assert.ok(!first.promptSegments.some((p) => p.capabilityId === "skills"));
    await js("document.querySelector('#my-agent').click(); document.querySelector('[data-capability=skills] input').click(); waitForUI(() => document.querySelector('#capability-status').textContent.includes('已保存'))");
    assert.equal(await js("document.querySelectorAll('.capability-exclusive').length"), 5);
    await js("document.querySelector('[data-capability=skills] button').click()");
    assert.equal(await js("document.querySelector('#send').dataset.running"), "false");
    assert.match(await js("document.querySelector('#prompt').value"), /Skill/);
    await js("document.querySelector('#composer').requestSubmit(); waitForUI(() => document.querySelectorAll('.xray-stats').length === 2 && document.querySelector('#send').dataset.running === 'false')");
    const second = await js("turns[1]");
    assert.ok(second.events.find((e) => e.type === "llm.request").toolNames.includes("skill_load"));
    assert.ok(second.promptSegments.some((p) => p.capabilityId === "skills"));
    await js("document.querySelectorAll('.xray-stats')[1].click(); document.querySelector('#xray-tab-prompt').click(); waitForUI(() => document.querySelector('.xray-diff-status')?.textContent.includes('新增 1'))");
    assert.match(await js("document.querySelector('#xray-prompt').textContent"), /capabilities\/skills.md/);
    await writeFile(join(root, "identity.json"), JSON.stringify({ sessionId: first.sessionId, first: first.id, second: second.id }));
    await js("document.querySelector('#xray-tab-timeline').click(); waitForUI(() => document.querySelector('.xray-model .xray-help-toggle'))");
    await js("document.querySelector('.xray-model .xray-help-toggle').click()");
    const learning = await js("window.personalAgent.achievements()");
    const unlockedIds = learning.achievements.map((item) => item.id);
    for (const id of ["first-turn", "first-tool", "xray-open", "xray-prompt", "explain-1", "cap-first"]) assert.ok(unlockedIds.includes(id), id);
    await js("document.querySelector('#xray-close').click(); document.querySelector('#achievements').click(); waitForUI(() => document.querySelectorAll('.achievement-card').length === 30)");
    await js("document.querySelector('[data-achievement=cap-first]').click()");
    assert.match(await js("document.querySelector('#achievement-status').textContent"), /没有关联/);
    await js("document.querySelector('#achievement-export').click(); waitForUI(() => document.querySelector('#achievement-status').textContent.includes('已导出'))");
    const exported = JSON.parse(await readFile(join(root, "learning-export.json"), "utf8"));
    assert.deepEqual(Object.keys(exported).sort(), ["achievements", "capabilities", "counters"]);
    assert.ok(!JSON.stringify(exported).includes('本地假模型完成'));
    await js("document.querySelector('[data-achievement=first-turn]').click(); waitForUI(() => !document.querySelector('#achievements-dialog').open && document.querySelector('#xray-turn').value === " + JSON.stringify(first.id) + ")");
    await js("document.querySelector('#xray-close').click(); document.querySelector('#my-agent').click()");
    const screenshots = process.env.BUILDME_CAPABILITY_SCREENSHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      for (const [name, width, theme] of [["dark", 1360, "dark"], ["light", 1360, "light"], ["narrow", 600, "light"]]) {
        window.setSize(width, 900);
        await js(`document.documentElement.dataset.theme = '${theme}'; nextFrame()`);
        await writeFile(join(screenshots, name + ".png"), (await window.webContents.capturePage()).toPNG());
      }
    }
    await js("document.querySelector('#capability-close').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await js("nextFrame()");
    assert.equal(await js("document.querySelector('#capabilities-dialog').open"), false);
    console.log("CAPABILITIES_SMOKE " + JSON.stringify({ phase, minimalOnboarding: true, twoRealPiTurns: true, skillToolAndPromptDiff: true, examplesFillOnly: true, keyboardEscape: true, achievements: true, exactSourceTurn: true, privateExport: true }));
  } else {
    const identity = JSON.parse(await readFile(join(root, "identity.json"), "utf8"));
    const state = await js("window.personalAgent.state()");
    assert.deepEqual(state.capabilities, ["core", "skills"]); assert.equal(state.capabilityOnboarding, false);
    assert.equal(state.capabilityUsage.core, 2); assert.equal(state.capabilityUsage.skills, 0);
    const turns = await js(`window.personalAgent.xrayTurns(${JSON.stringify(identity.sessionId)})`); assert.equal(turns.length, 2);
    assert.ok((await js(`window.personalAgent.xrayTurn(${JSON.stringify(identity.second)})`)).promptSegments.some((p) => p.capabilityId === "skills"));
    const learning = await js("window.personalAgent.achievements()");
    assert.ok(learning.achievements.some((item) => item.id === "first-turn"));
    assert.equal(learning.counters.turns, 2);
    console.log("CAPABILITIES_SMOKE " + JSON.stringify({ phase, restoredAchievements: true, restoredCapabilities: true, actualUsage: state.capabilityUsage.core, restoredSnapshots: true }));
  }
  app.quit();
}
void import(pathToFileURL(join(project, "desktop/main.mjs")).href).catch((error) => { console.error(error); app.exit(1); });
