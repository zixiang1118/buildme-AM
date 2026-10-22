const { app, ipcMain, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

async function captureOffscreen(window) {
  let error;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (image.toPNG().length < 8000) throw new Error("Screenshot contains no rendered interface");
      return image;
    } catch (failure) {
      error = failure;
      await window.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 150))");
    }
  }
  throw error;
}

const [, , phase, root, project] = process.argv;
console.log("EXPERIENCES_PROGRESS " + phase + " boot");
app.setPath("userData", join(root, "user-data"));
app.setPath("appData", join(root, "app-data"));
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

let sendCount = 0;
let holdNextSend = false;
let releaseSend;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, channel === "desktop:community-hide" ? (_event, ...args) => handler({ sender: nativeWindow.webContents, senderFrame: nativeWindow.webContents.mainFrame }, ...args) : channel === "desktop:send" ? async (...args) => {
  sendCount += 1;
  if (holdNextSend) {
    holdNextSend = false;
    await new Promise((resolveSend) => { releaseSend = resolveSend; });
  }
  return handler(...args);
} : handler);

let nativeWindow, captureWindow;
app.on("browser-window-created", (_event, window) => {
  console.log("EXPERIENCES_PROGRESS window-created");
  window.hide();
  window.on("show", () => window.hide());
  window.webContents.setBackgroundThrottling(false);
  if (nativeWindow) return;
  nativeWindow = window;
  window.webContents.once("did-finish-load", () => {
    console.log("EXPERIENCES_PROGRESS loaded");
    // Hidden native Windows windows have no drawable surface. A separate
    // offscreen window loads the real renderer/preload against the same IPC.
    captureWindow = new BrowserWindow({ width: 1040, height: 720, show: false, webPreferences: {
      preload: join(project, "desktop", "preload.cjs"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false,
    } });
    const send = nativeWindow.webContents.send.bind(nativeWindow.webContents);
    // Forward real runtime events to the offscreen renderer under test.
    nativeWindow.webContents.send = (name, ...args) => {
      send(name, ...args);
      if (!captureWindow.isDestroyed()) captureWindow.webContents.send(name, ...args);
    };
    const verifyCapture = async () => verify(captureWindow);
    captureWindow.webContents.once("did-finish-load", () => void verifyCapture().catch(async (error) => {
      console.error(error);
      try {
        console.error("EXPERIENCES_UI " + JSON.stringify(await captureWindow.webContents.executeJavaScript(`({
          mode: document.body.dataset.experience,
          trigger: document.querySelector('#experience-trigger')?.outerHTML,
          status: document.querySelector('#status')?.textContent,
          errors: window.experienceUIErrors,
        })`)));
        if (process.env.BUILDME_EXPERIENCE_SCREENSHOTS) {
          await writeFile(join(process.env.BUILDME_EXPERIENCE_SCREENSHOTS, `failure-${phase}.png`), (await captureOffscreen(captureWindow)).toPNG());
        }
      } catch (captureError) { console.error(captureError); }
      app.exit(1);
    }));
    void captureWindow.loadFile(join(project, "desktop", "renderer", "index.html"));
  });
});

async function verify(window) {
  const js = (code) => window.webContents.executeJavaScript(code);
  await js(`window.experienceUIErrors = [];
    window.addEventListener('error', event => experienceUIErrors.push(event.message));
    window.addEventListener('unhandledrejection', event => experienceUIErrors.push(String(event.reason)));
    window.waitExperienceUI = predicate => new Promise((resolve, reject) => {
      if (predicate()) return resolve();
      const timeout = setTimeout(() => { observer.disconnect(); reject(Error('UI timeout: ' + predicate)); }, 10000);
      const observer = new MutationObserver(() => {
        if (predicate()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    // Chromium can suspend animation frames for hidden Windows surfaces.
    window.experienceFrame = () => new Promise(resolve => {
      const timeout = setTimeout(resolve, 80);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
    });
    window.experienceSettled = async () => {
      await experienceFrame();
      await Promise.race([
        Promise.allSettled(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished)),
        new Promise(resolve => setTimeout(resolve, 1200)),
      ]);
      await experienceFrame();
    };
    window.experienceKey = key => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    waitExperienceUI(() => document.querySelector('#experience-trigger')?.dataset.ready === 'true')`);
  const state = () => js("window.personalAgent.state()");
  const baseline = await state();
  console.log("EXPERIENCES_PROGRESS initialized " + baseline.experienceMode);
  const preserve = (value) => ({
    edition: value.edition, activeConnectionId: value.activeConnectionId, connections: value.connections,
    workspace: value.workspace, permissionMode: value.permissionMode, theme: value.theme,
  });
  const switchMode = async (mode) => {
    console.log("EXPERIENCES_PROGRESS switch " + mode);
    await js(`if (document.querySelector('#experience-menu').hidden) document.querySelector('#experience-trigger').click();
      waitExperienceUI(() => !document.querySelector('#experience-menu').hidden)`);
    await js(`document.querySelector('.experience-option[data-mode="${mode}"]').click();
      waitExperienceUI(() => document.body.dataset.experience === '${mode}' && document.querySelector('#experience-menu').hidden && document.querySelector('#experience-trigger').dataset.ready === 'true' && document.querySelector('#experience-trigger').dataset.switching !== 'true')`);
    await js("experienceSettled()");
    assert.equal((await state()).experienceMode, mode);
    assert.equal(await js("document.querySelector('#platform-entry').hidden"), mode !== "research", "Platform entry belongs only to the research version.");
    assert.equal(await js("getComputedStyle(document.querySelector('#platform-entry')).display === 'none'"), mode !== "research");
  };

  if (phase === "read") {
    assert.equal(baseline.experienceMode, "research");
    assert.equal(await js("document.body.dataset.experience"), "research");
    assert.match(await js("document.querySelector('#experience-current').textContent"), /科研/);
    assert.ok(await js("!!document.querySelector('.experience-home')"));
    assert.equal(sendCount, 0);
    console.log("EXPERIENCES_SMOKE " + JSON.stringify({ phase, persistedMode: true, hiddenWindow: !window.isVisible(), noModelRequests: true }));
    app.quit();
    return;
  }

  assert.equal(baseline.experienceMode, "original");
  assert.equal(await js("document.querySelectorAll('.experience-option').length"), 3);
  assert.ok(await js("!!document.querySelector('#experience-header-badge')"));
  await js("document.querySelector('#prompt').value = '切换时保留的草稿'; document.querySelector('#prompt').dispatchEvent(new Event('input', { bubbles: true }))");
  for (const mode of ["learning", "research", "original"]) {
    await switchMode(mode);
    assert.deepEqual(preserve(await state()), preserve(baseline));
    assert.deepEqual(JSON.parse(await readFile(join(root, "user-data", "desktop-settings.json"), "utf8")).capabilities, baseline.capabilities, "Research capabilities apply only to research requests, keeping saved user preferences.");
    assert.equal(await js("document.querySelector('#prompt').value"), "切换时保留的草稿");
    assert.ok(await js("!!document.querySelector('.experience-home')"));
    assert.equal(sendCount, 0, "Mode switching must not send a model request.");
  }

  await js("document.querySelector('#experience-trigger').focus(); document.querySelector('#experience-trigger').click(); waitExperienceUI(() => !document.querySelector('#experience-menu').hidden)");
  const focusedBefore = await js("document.activeElement.dataset.mode");
  await js("experienceKey('ArrowDown')");
  const focusedAfter = await js("document.activeElement.dataset.mode");
  assert.ok(["original", "learning", "research"].includes(focusedAfter));
  assert.notEqual(focusedAfter, focusedBefore, "ArrowDown must move focus between version choices.");
  await js("experienceKey('Escape'); waitExperienceUI(() => document.querySelector('#experience-menu').hidden)");
  assert.equal(await js("document.activeElement.id"), "experience-trigger");

  await switchMode("learning");
  const learningSteps = await js("[...document.querySelectorAll('.learning-node')].map(node => node.dataset.step)");
  assert.ok(learningSteps.length >= 3);
  const explanations = new Set();
  for (const step of learningSteps) {
    await js(`document.querySelector('.learning-node[data-step="${step}"]').click()`);
    assert.equal(await js(`document.querySelector('.learning-node[data-step="${step}"]').getAttribute('aria-pressed')`), "true");
    explanations.add(await js("document.querySelector('#learning-explanation').textContent"));
  }
  assert.equal(explanations.size, learningSteps.length, "Each learning step needs its own explanation.");
  await js("document.querySelector('.experience-card').click(); experienceFrame()");
  assert.ok(await js("document.querySelector('#prompt').value.trim().length > 0"));
  assert.equal(sendCount, 0, "Prompt cards must fill only.");
  await js("document.querySelector('.experience-tool[data-action=capabilities]').click(); waitExperienceUI(() => document.querySelector('#capabilities-dialog').open)");
  await js("document.querySelector('#capability-close').click()");
  await js("document.querySelector('.experience-tool[data-action=xray]').click(); waitExperienceUI(() => document.body.classList.contains('xray-open'))");
  await js("document.querySelector('#xray-close').click()");

  await switchMode("research");
  const researchStages = await js("[...document.querySelectorAll('.research-stage')].map(node => node.dataset.stage)");
  assert.ok(researchStages.length >= 3);
  const researchCards = new Set();
  for (const stage of researchStages) {
    await js(`document.querySelector('.research-stage[data-stage="${stage}"]').click()`);
    researchCards.add(await js("[...document.querySelectorAll('.experience-card')].map(card => card.textContent).join(' | ')"));
  }
  assert.equal(researchCards.size, researchStages.length, "Each research stage needs different actions.");
  await js("document.querySelector('.experience-card').click(); experienceFrame()");
  assert.ok(await js("document.querySelector('#prompt').value.trim().length > 0"));
  assert.equal(sendCount, 0);

  holdNextSend = true;
  await js("document.querySelector('#prompt').value = '本地验收，不连接外部模型'; document.querySelector('#composer').requestSubmit(); waitExperienceUI(() => document.querySelector('#send').dataset.running === 'true')");
  await new Promise((resolveGate, rejectGate) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (releaseSend) resolveGate();
      else if (Date.now() > deadline) rejectGate(new Error("Local faux request did not reach the intercepted IPC handler."));
      else setImmediate(check);
    };
    check();
  });
  assert.equal(sendCount, 1);
  const modeDuringRun = (await state()).experienceMode;
  await js("document.querySelector('#experience-trigger').click(); document.querySelector('.experience-option[data-mode=learning]').click(); experienceFrame()");
  assert.equal((await state()).experienceMode, modeDuringRun, "A running conversation must block version changes.");
  assert.equal(await js("document.body.dataset.experience"), modeDuringRun);
  assert.ok(releaseSend, "The local faux run should be waiting at the intercepted send boundary.");
  releaseSend();
  await js("waitExperienceUI(() => document.querySelector('#send').dataset.running === 'false' && document.querySelector('.message.assistant')?.textContent.includes('本地假模型完成'))");
  const localSession = await js("document.querySelector('#session-list .session')?.dataset.id");
  assert.ok(localSession, "The local faux run must create a real session.");
  const turns = await js(`window.personalAgent.xrayTurns(${JSON.stringify(localSession)}, 'pi')`);
  assert.ok(turns.length > 0, "The local faux run must record a real Pi trace.");
  const trace = await js(`window.personalAgent.xrayTurn(${JSON.stringify(turns.at(-1).id)})`);
  assert.ok(trace.promptSegments.some(segment => segment.text.includes("科研版")), "The real Pi request must receive the research experience system prompt.");
  const historyBefore = await js("document.querySelector('#messages').textContent");
  await js("document.querySelector('#prompt').value = '同版本选择保留草稿'");
  await switchMode("research");
  assert.equal(await js("document.querySelector('#messages').textContent"), historyBefore, "Choosing the current version must preserve the conversation.");
  assert.equal(await js("document.querySelector('#prompt').value"), "同版本选择保留草稿");
  await switchMode("learning");
  assert.equal(await js("document.querySelectorAll('#messages .message').length"), 0, "A new version opens a fresh conversation.");
  assert.equal(await js("document.querySelector('#prompt').value"), "同版本选择保留草稿");
  assert.equal(sendCount, 1);

  const screenshots = process.env.BUILDME_EXPERIENCE_SCREENSHOTS;
  await js("document.querySelector('#achievement-toast').hidden = true");
  await mkdir(screenshots, { recursive: true });
  window.setMinimumSize(320, 480);
  for (const mode of ["original", "learning", "research"]) {
    await switchMode(mode);
    await js("document.querySelector('#prompt').value = ''; document.querySelector('#prompt').dispatchEvent(new Event('input', { bubbles: true }))");
    for (const [name, width, height, theme] of [["dark", 1040, 720, "dark"], ["light", 1040, 720, "light"], ["mobile", 600, 780, "dark"]]) {
      window.setSize(width, height);
      await js(`document.documentElement.dataset.theme = '${theme}'; document.querySelector('#close-sidebar').click(); experienceSettled()`);
      assert.ok(await js("document.documentElement.scrollWidth <= innerWidth"), `${mode} ${name}: page must not overflow horizontally.`);
      const offscreen = await js("[...document.querySelectorAll('.experience-home button')].filter(node => node.getBoundingClientRect().width > 0).filter(node => { const rect = node.getBoundingClientRect(); return rect.left < -1 || rect.right > innerWidth + 1; }).map(node => node.className)");
      assert.deepEqual(offscreen, [], `${mode} ${name}: home controls must remain in the viewport.`);
      await writeFile(join(screenshots, `${mode}-${name}.png`), (await captureOffscreen(window)).toPNG());
    }
  }
  window.setSize(1040, 720);
  await js("document.documentElement.dataset.theme = 'dark'; document.querySelector('#experience-trigger').click(); experienceSettled()");
  await writeFile(join(screenshots, "version-menu.png"), (await captureOffscreen(window)).toPNG());
  await js("experienceKey('Escape'); experienceFrame()");
  assert.equal((await state()).experienceMode, "research");
  const saved = JSON.parse(await readFile(join(root, "user-data", "desktop-settings.json"), "utf8"));
  assert.equal(saved.experienceMode, "research");
  assert.deepEqual(preserve(await state()), preserve(baseline));
  assert.deepEqual(saved.capabilities, baseline.capabilities);
  assert.deepEqual(await js("experienceUIErrors"), []);
  console.log("EXPERIENCES_SMOKE " + JSON.stringify({
    phase, threeModes: true, settingsAndDraftPreserved: true, keyboardMenu: true, interactiveLearning: true,
    researchStages: true, realToolPanels: true, cardsFillOnly: true, blockedDuringRun: true, sameModePreservesChat: true,
    hiddenWindow: !window.isVisible(), modelRequests: sendCount, externalModelRequests: 0, realPiResearchPrompt: true, screenshots,
  }));
  app.quit();
}

void import(pathToFileURL(join(project, "desktop", "main.mjs")).href).catch((error) => { console.error(error); app.exit(1); });
