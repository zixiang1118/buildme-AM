const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const [, , phase, root, project, screenshots] = process.argv;
app.setPath("userData", join(root, "user-data")); app.setPath("appData", join(root, "app-data"));
app.commandLine.appendSwitch("force-device-scale-factor", "1"); app.disableHardwareAcceleration();
let nativeWindow, window, workspaceDialog;
dialog.showOpenDialog = async (...args) => { workspaceDialog = args.at(-1); return { canceled: false, filePaths: [join(root, "workspace")] }; };
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, (event, ...args) => {
  assert.notEqual(channel, "desktop:send", "Permission verification must never invoke a model.");
  const trusted = channel.startsWith("desktop:platform-") || channel === "desktop:community-hide";
  return handler(trusted ? { sender: nativeWindow.webContents, senderFrame: nativeWindow.webContents.mainFrame } : event, ...args);
});
app.on("browser-window-created", (_event, created) => {
  if (created.webContents.isOffscreen()) return;
  created.hide(); created.on("show", () => created.hide()); created.webContents.setBackgroundThrottling(false);
  if (nativeWindow) return; nativeWindow = created;
  created.webContents.once("did-finish-load", () => {
    window = new BrowserWindow({ width: 1120, height: 820, show: false, paintWhenInitiallyHidden: true, webPreferences: { preload: join(project, "desktop", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    window.webContents.setFrameRate(60); window.webContents.startPainting();
    const originalSend = created.webContents.send.bind(created.webContents);
    created.webContents.send = (channel, ...args) => { originalSend(channel, ...args); if (!window.isDestroyed()) window.webContents.send(channel, ...args); };
    window.webContents.once("did-finish-load", () => void verify().then(() => app.quit()).catch(async error => {
      console.error(error); try { console.error("PERMISSION_UI " + JSON.stringify(await js("({errors:window.permissionErrors,status:document.querySelector('#status').textContent,menu:document.querySelector('#permission-menu').hidden,label:document.querySelector('#permission-label').textContent})"))); await shot(`failure-${phase}`); } catch (captureError) { console.error(captureError); } app.exit(1);
    }));
    void window.loadFile(join(project, "desktop", "renderer", "index.html"));
  });
});
const js = code => window.webContents.executeJavaScript(code);
const settle = () => js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
async function shot(name) {
  let error;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await js("new Promise(resolve=>setTimeout(resolve,300))");
      const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      assert.ok(image.toPNG().length > 8000); await writeFile(join(screenshots, `${name}.png`), image.toPNG()); return;
    } catch (failure) { error = failure; }
  }
  throw error;
}
async function click(selector) {
  const point = await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);return {x,y,hit:node.contains(document.elementFromPoint(x,y))};})()`);
  assert.ok(point.hit, `${selector} must be hit-testable before clicking: ${JSON.stringify(point)}`);
  window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await settle();
}
async function menuGeometry() {
  return js(`(()=>{const menu=document.querySelector('#permission-menu'),context=document.querySelector('.context-bar'),r=context.getBoundingClientRect();return {hidden:menu.hidden,expanded:document.querySelector('#permission-chip').getAttribute('aria-expanded'),overflowX:getComputedStyle(context).overflowX,overflowY:getComputedStyle(context).overflowY,context:{top:r.top,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},options:[...menu.querySelectorAll('[data-permission]')].map(node=>{const b=node.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2;return {mode:node.dataset.permission,left:b.left,right:b.right,top:b.top,bottom:b.bottom,hit:node.contains(document.elementFromPoint(x,y))};})};})()`);
}
async function visibleMenu() {
  await click("#permission-chip"); await js("waitPermission(()=>!document.querySelector('#permission-menu').hidden)");
  return assertVisibleMenu();
}
async function assertVisibleMenu() {
  const geometry = await menuGeometry(); assert.equal(geometry.hidden, false); assert.equal(geometry.expanded, "true"); assert.equal(geometry.options.length, 3);
  for (const option of geometry.options) assert.ok(option.hit && option.left>=0 && option.right<=geometry.viewport.width && option.top>=0 && option.bottom<=geometry.viewport.height, `Permission option must be visible and reachable: ${JSON.stringify(geometry)}`);
  return geometry;
}
async function select(mode) {
  await visibleMenu(); await click(`[data-permission="${mode}"]`);
  await js(`waitPermission(()=>document.querySelector('[data-permission="${mode}"]').getAttribute('aria-checked')==='true'&&document.querySelector('#permission-menu').hidden)`);
  assert.equal(await js("personalAgent.state().then(state=>state.permissionMode)"), mode);
}
async function switchMode(mode) {
  await js(`waitPermission(()=>document.querySelector('#experience-trigger').dataset.ready==='true'&&document.querySelector('#experience-trigger').dataset.switching!=='true');document.querySelector('#experience-trigger').click();document.querySelector('.experience-option[data-mode=${mode}]').click();waitPermission(()=>document.body.dataset.experience==='${mode}'&&document.querySelector('#experience-trigger').dataset.ready==='true'&&document.querySelector('#experience-trigger').dataset.switching!=='true')`);
}
async function verify() {
  await js(`window.permissionErrors=[];addEventListener('error',e=>permissionErrors.push(e.message));addEventListener('unhandledrejection',e=>permissionErrors.push(String(e.reason)));window.waitPermission=predicate=>new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(predicate()){clearInterval(timer);resolve();}else if(Date.now()-start>15000){clearInterval(timer);reject(Error('界面等待超时: '+predicate));}},35);});waitPermission(()=>document.querySelector('#experience-trigger')?.dataset.ready==='true')`);
  if (phase === "probe") {
    await click("#permission-chip"); await settle(); const geometry = await menuGeometry(); await shot("before-fix-clipped-menu");
    console.log("PERMISSION_PROBE " + JSON.stringify(geometry)); return;
  }
  if (phase === "read") {
    assert.equal(await js("personalAgent.state().then(state=>state.permissionMode)"), "workspace-write");
    assert.equal(await js("document.querySelector('#permission-label').textContent"), "工作区内自动执行");
    assert.equal(await js("personalAgent.state().then(state=>state.workspace.path)"), join(root, "workspace"));
    await visibleMenu(); await shot("restart-selected"); assert.deepEqual(await js("permissionErrors"), []);
    console.log("PERMISSION_SMOKE " + JSON.stringify({ phase, persisted: true })); return;
  }
  assert.equal(await js("document.querySelector('#workspace-label').textContent"), "选择工作空间");
  assert.equal(await js("document.querySelector('#workspace-chip').title"), "选择工作空间");
  await visibleMenu(); await shot("original-dark"); await click("#prompt");
  assert.equal(await js("document.querySelector('#permission-menu').hidden"), true, "Outside click closes menu.");
  for (const mode of ["workspace-write", "bypass", "ask"]) await select(mode);
  await visibleMenu(); window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await settle();
  assert.equal(await js("document.querySelector('#permission-menu').hidden"), true);
  assert.equal(await js("document.activeElement.id"), "permission-chip");
  await js("document.querySelector('#theme-light').click();waitPermission(()=>document.documentElement.dataset.theme==='light')");
  await visibleMenu(); await shot("original-light"); await click("#prompt");
  await switchMode("research"); await visibleMenu(); await shot("research-light"); await click("#prompt");
  await js("document.querySelector('#theme-dark').click();waitPermission(()=>document.documentElement.dataset.theme==='dark')");
  window.setSize(440, 720); await settle();
  await js("document.querySelector('#permission-chip').scrollIntoView({block:'nearest',inline:'nearest'})"); await settle();
  const narrow = await visibleMenu(); await shot("research-compact-dark"); assert.ok(await js("document.documentElement.scrollWidth<=innerWidth"));
  const horizontal = await js("(()=>{const context=document.querySelector('.context-bar');context.scrollLeft=context.scrollWidth-context.clientWidth;return {maximum:context.scrollWidth-context.clientWidth,left:context.scrollLeft};})()");
  assert.ok(horizontal.maximum>0 && horizontal.left>0, "Narrow viewport must exercise horizontal context scrolling."); await settle(); await assertVisibleMenu();
  window.setSize(500, 760); await settle(); await assertVisibleMenu();
  await click("#chat-title");
  window.setSize(1120, 820); await settle();
  await click("#workspace-chip"); await js("waitPermission(()=>document.querySelector('#workspace-label').textContent==='workspace')");
  assert.equal(workspaceDialog.buttonLabel, "选择工作空间"); assert.ok(workspaceDialog.title.includes("工作空间")); assert.ok(workspaceDialog.properties.includes("openDirectory"));
  await select("workspace-write");
  await writeFile(join(root, "permission-acceptance.json"), JSON.stringify({ selections: ["workspace-write", "bypass", "ask", "workspace-write"], persistedMode: "workspace-write", narrowGeometry: narrow, horizontalScroll: horizontal }));
  assert.deepEqual(await js("permissionErrors"), []);
  console.log("PERMISSION_SMOKE " + JSON.stringify({ phase, selections: 4, themes: 2, research: true, narrow: true }));
}
void import(pathToFileURL(join(project, "desktop", "main.mjs")).href).catch(error => { console.error(error); app.exit(1); });
