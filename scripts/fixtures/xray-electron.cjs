const { app, clipboard } = require("electron");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
let copiedText = "";
clipboard.writeText = (text) => { copiedText = text; };
clipboard.readText = () => copiedText;

const [, , phase, root, project] = process.argv;
app.setPath("userData", join(root, "user-data"));
app.setPath("appData", join(root, "app-data"));
app.on("browser-window-created", (_event, window) => {
  window.hide();
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once("did-finish-load", () => void verify(window).catch((error) => { console.error(error); app.exit(1); }));
});

async function verify(window) {
  const js = (code) => window.webContents.executeJavaScript(code);
  window.show();
  window.focus();
  window.webContents.focus();
  await js(`window.xrayUIErrors = [];
  window.addEventListener('error', event => xrayUIErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => xrayUIErrors.push(String(event.reason)));
  window.waitForXrayUI = (predicate) => new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('UI timeout: ' + predicate)); }, 10000);
    const observer = new MutationObserver(() => { if (predicate()) { clearTimeout(timeout); observer.disconnect(); resolve(); } });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }); window.nextXrayFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); void 0;`);
  await js("window.personalAgent.state()");
  if (phase === "write") {
    await js("waitForXrayUI(() => document.querySelector('#capability-onboarding').open)");
    await js("document.querySelector('#capability-choose-all').click(); waitForXrayUI(() => !document.querySelector('#capability-onboarding').open)");
    const result = await js(`(async () => {
      const events = [];
      let finalTurn;
      let liveToolsVisible = false;
      const observer = new MutationObserver(() => { if (document.querySelector('.xray-status-running') && document.querySelector('.xray-tool')) liveToolsVisible = true; });
      observer.observe(document.querySelector('#xray-panel'), { subtree: true, childList: true });
      const off = window.personalAgent.onXray((notification) => { events.push(notification); if (notification.type === 'turn-end') finalTurn = notification.turn; });
      document.querySelector('#xray-toggle').click();
      document.querySelector('#prompt').value = "local verification sk-test-AAAAAAAAAAAAAAAAAAAA";
      document.querySelector('#composer').requestSubmit();
      await waitForXrayUI(() => document.querySelector('.xray-status-done') && document.querySelector('#send').dataset.running === 'false');
      off();
      observer.disconnect();
      const summaries = await window.personalAgent.xrayTurns(finalTurn.sessionId);
      const turn = await window.personalAgent.xrayTurn(summaries[0].id);
      const stats = document.querySelector('.xray-stats');
      const toolCards = document.querySelectorAll('.xray-tool').length;
      const input = document.querySelector('.xray-input').textContent;
      document.querySelector('.xray-tool summary').focus();
      return { sessionId: turn.sessionId, turnId: turn.id, count: turn.events.length, events, turn, stats: stats.textContent, statsId: stats.dataset.turnId, toolCards, input, liveToolsVisible, parallel: !!document.querySelector('.xray-parallel') };
    })()`);
    assert.equal(result.turn.status, "done");
    assert.equal(result.turn.usage.toolCalls, 66);
    assert.ok(result.count >= 200);
    assert.ok(result.events.some((event) => event.type === "event" && event.event.type === "llm.request"));
    assert.ok(!JSON.stringify(result.events).includes("sk-test-AAAAAAAAAAAAAAAAAAAA"));
    assert.ok(!result.input.includes("sk-test-AAAAAAAAAAAAAAAAAAAA"));
    assert.equal(result.statsId, result.turnId);
    assert.ok(result.stats.includes("66 个工具"));
    assert.equal(result.toolCards, 66);
    assert.ok(result.parallel);
    assert.ok(result.liveToolsVisible, "Tools must render before the turn ends");
    const explain = await js(`(async () => {
      const before = await window.personalAgent.xrayTurns(${JSON.stringify(result.sessionId)});
      const history = document.querySelector('#messages').innerHTML;
      document.querySelector('.xray-model .xray-help-toggle').focus();
      return { before, history };
    })()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('.xray-model .xray-help-card').hidden"), false);
    assert.equal(await js("document.querySelectorAll('.xray-model .xray-help-card h4').length"), 3);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('.xray-model .xray-help-card').hidden && !document.querySelector('#xray-panel').hidden && document.activeElement === document.querySelector('.xray-model .xray-help-toggle')"), true);
    assert.deepEqual(await js(`window.personalAgent.xrayTurns(${JSON.stringify(result.sessionId)})`), explain.before);
    assert.equal(await js("document.querySelector('#messages').innerHTML"), explain.history);
    await js("document.querySelector('.xray-tool summary').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('.xray-tool details').open"), true);
    await js("document.querySelector('#xray-advanced').click(); document.querySelector('#xray-resize').focus()");
    for (let index = 0; index < 3; index++) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
    }
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('#xray-resize').getAttribute('aria-valuenow')"), "480");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "X", modifiers: ["control", "shift"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "X", modifiers: ["control", "shift"] });
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('#xray-panel').hidden"), true);
    await js("document.querySelector('.xray-stats').click(); nextXrayFrame()");
    const inspection = await js(`(async () => {
      document.querySelector('#xray-tab-prompt').click();
      await waitForXrayUI(() => document.querySelectorAll('.xray-segment').length === 2);
      document.querySelector('#xray-prompt .xray-small-action').click();
      await waitForXrayUI(() => document.querySelector('#xray-prompt .xray-action-status').textContent === '已复制');
      const prompt = await window.personalAgent.readClipboardText();
      document.querySelector('#xray-tab-context').click();
      await waitForXrayUI(() => document.querySelectorAll('.xray-context-call').length === 2);
      document.querySelector('#xray-tab-raw').click();
      await waitForXrayUI(() => document.querySelector('.xray-json-node'));
      document.querySelector('#xray-raw .xray-small-action').click();
      await waitForXrayUI(() => document.querySelector('#xray-raw .xray-action-status').textContent === '已复制');
      const raw = JSON.parse(await window.personalAgent.readClipboardText());
      const select = document.querySelector('.xray-raw-select');
      select.selectedIndex = 1; select.dispatchEvent(new Event('change'));
      const choices = select.options.length;
      document.querySelector('#xray-tab-timeline').click();
      document.querySelector('#xray-follow').click();
      document.querySelector('#prompt').value = 'second local verification';
      document.querySelector('#composer').requestSubmit();
      await waitForXrayUI(() => document.querySelector('#xray-turn').options.length === 2 && document.querySelector('#send').dataset.running === 'false');
      document.querySelector('#xray-tab-prompt').click();
      await waitForXrayUI(() => document.querySelector('.xray-diff-status')?.textContent.includes('新增 1'));
      const summaries = await window.personalAgent.xrayTurns(${JSON.stringify(result.sessionId)});
      const second = await window.personalAgent.xrayTurn(summaries.find(turn => turn.turnIndex === 2).id);
      const percentages = [...document.querySelectorAll('.xray-proportion .xray-swatch')].map(node => Math.round(parseFloat(node.style.width) * 10));
      return { prompt, raw, choices, secondId: second.id, percentages, segments: second.promptSegments.length, exactSecondPrompt: second.promptSegments.map(segment => segment.text).join('\\n\\n') === second.events.find(event => event.type === 'llm.request').raw.context.systemPrompt };
    })()`);
    assert.equal(inspection.prompt, inspection.raw.context.systemPrompt);
    assert.equal(inspection.raw.format, "pi-context");
    assert.ok(!JSON.stringify(inspection.raw).includes("sk-test-AAAAAAAAAAAAAAAAAAAA"));
    assert.equal(inspection.choices, 2);
    assert.equal(inspection.segments, 3);
    assert.equal(inspection.percentages.reduce((sum, value) => sum + value, 0), 1000);
    assert.equal(inspection.exactSecondPrompt, true);
    await writeFile(join(root, "identity.json"), JSON.stringify({ sessionId: result.sessionId, turnId: result.turnId, secondId: inspection.secondId }));
    console.log("XRAY_SMOKE " + JSON.stringify({ phase: "write", eventCount: result.count, liveIPC: true, redacted: true, composerUI: true, toolCards: result.toolCards, keyboardExpandResizeToggle: true, inspectionTabs: true, promptDiff: true, clipboardIPC: true, staticExplanation: true, unchangedHistory: true }));
  } else {
    const identity = JSON.parse(await readFile(join(root, "identity.json"), "utf8"));
    assert.equal(await js("document.querySelector('#xray-panel').hidden"), false);
    assert.equal(await js("document.querySelector('#xray-panel').dataset.mode"), "advanced");
    assert.equal(await js("document.querySelector('#xray-resize').getAttribute('aria-valuenow')"), "480");
    const result = await js(`(async () => {
      const start = performance.now();
      const turn = await window.personalAgent.xrayTurn(${JSON.stringify(identity.turnId)});
      const queryMs = performance.now() - start;
      await waitForXrayUI(() => document.querySelector('.session'));
      document.querySelector('.session').click();
      await waitForXrayUI(() => document.querySelector('#xray-turn').options.length === 2 && document.querySelector('.xray-stats'));
      const renderStart = performance.now();
      const select = document.querySelector('#xray-turn'); select.value = ${JSON.stringify(identity.turnId)}; select.dispatchEvent(new Event('change'));
      await waitForXrayUI(() => document.querySelectorAll('.xray-tool').length === 66);
      const domMs = performance.now() - renderStart;
      await nextXrayFrame();
      return { turn, queryMs, domMs, renderMs: performance.now() - renderStart, statsIds: [...document.querySelectorAll('.xray-stats')].map(node => node.dataset.turnId) };
    })()`);
    assert.equal(result.turn.status, "done");
    assert.ok(result.turn.events.length >= 200);
    assert.ok(result.queryMs < 100, `IPC query took ${result.queryMs}ms`);
    assert.ok(result.renderMs < 300, `Drawer rendering took ${result.renderMs}ms (DOM ready at ${result.domMs}ms)`);
    assert.ok(result.statsIds.length >= 1);
    assert.equal(result.statsIds.filter((id) => id === identity.turnId).length, 2);
    assert.equal(result.statsIds.filter((id) => id === identity.secondId).length, 1);
    const scroll = await js(`(async () => {
      const last = [...document.querySelectorAll('.xray-tool')].at(-1);
      last.scrollIntoView({ block: 'start' });
      await nextXrayFrame();
      last.querySelector('.xray-help-toggle').click();
      await nextXrayFrame();
      const help = last.querySelector('.xray-help-card').getBoundingClientRect();
      const panel = document.querySelector('#xray-timeline').getBoundingClientRect();
      return { scrolled: document.querySelector('#xray-timeline').scrollTop > 0, helpVisible: help.top < panel.bottom && help.bottom > panel.top };
    })()`);
    assert.deepEqual(scroll, { scrolled: true, helpVisible: true });
    await js("document.querySelector('#xray-tab-timeline').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('#xray-tab-prompt').getAttribute('aria-selected')"), "true");
    await js("document.querySelector('#xray-tab-timeline').click()");
    await js("document.querySelector('#xray-beginner').click()");
    await js("document.querySelector('.xray-model .xray-help-toggle').click(); nextXrayFrame()");
    if (process.env.BUILDME_XRAY_SCREENSHOTS) {
      await mkdir(process.env.BUILDME_XRAY_SCREENSHOTS, { recursive: true });
      for (const [name, width, theme] of [["dark", 1360, "dark"], ["light", 1360, "light"], ["narrow", 800, "light"]]) {
        window.setSize(width, 900);
        await js(`document.documentElement.dataset.theme = '${theme}'; nextXrayFrame()`);
        await js("Promise.all(document.getAnimations().map(animation => animation.finished))");
        await js("document.querySelector('#messages').scrollTo({ top: document.querySelector('#messages').scrollHeight, behavior: 'instant' }); nextXrayFrame()");
        await writeFile(join(process.env.BUILDME_XRAY_SCREENSHOTS, `${name}.png`), (await window.webContents.capturePage()).toPNG());
      }
      for (const [tab, width, theme] of [["prompt", 1360, "dark"], ["context", 1360, "light"], ["raw", 800, "light"]]) {
        window.setSize(width, 900);
        await js(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('#xray-advanced').click(); document.querySelector('#xray-tab-${tab}').click(); nextXrayFrame()`);
        if (tab === "prompt") await js(`document.querySelector('#xray-turn').value = ${JSON.stringify(identity.secondId)}; document.querySelector('#xray-turn').dispatchEvent(new Event('change')); waitForXrayUI(() => document.querySelector('.xray-diff-status')?.textContent.includes('新增 1'))`);
        if (tab === "context") await js(`document.querySelector('#xray-turn').value = ${JSON.stringify(identity.turnId)}; document.querySelector('#xray-turn').dispatchEvent(new Event('change')); waitForXrayUI(() => document.querySelectorAll('.xray-context-call').length === 2)`);
        await js("Promise.all(document.getAnimations().map(animation => animation.finished))");
        await writeFile(join(process.env.BUILDME_XRAY_SCREENSHOTS, `${tab}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
    await js("document.querySelector('#xray-tab-timeline').click(); nextXrayFrame()");
    window.setSize(800, 900);
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('.workspace').inert && document.querySelector('#xray-panel').getAttribute('aria-modal') === 'true'"), true);
    await js("document.querySelector('#xray-timeline').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('#xray-panel').contains(document.activeElement)"), true);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await js("nextXrayFrame()");
    assert.equal(await js("document.querySelector('#xray-panel').hidden && !document.querySelector('.workspace').inert"), true);
    console.log("XRAY_SMOKE " + JSON.stringify({ phase: "restart", eventCount: result.turn.events.length, queryMs: result.queryMs, renderMs: result.renderMs, restored: true, historyStats: result.statsIds.length, overlayKeyboard: true }));
  }
  assert.deepEqual(await js("window.xrayUIErrors"), []);
  app.quit();
}

void import(pathToFileURL(join(project, "desktop/main.mjs")).href).catch((error) => { console.error(error); app.exit(1); });
