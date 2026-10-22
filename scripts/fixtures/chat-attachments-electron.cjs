const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const [, , phase, root, project, screenshots] = process.argv;
app.setPath("userData", join(root, "user-data")); app.setPath("appData", join(root, "app-data"));
app.commandLine.appendSwitch("force-device-scale-factor", "1"); app.disableHardwareAcceleration();
let nativeWindow, window;
let chosen = [join(root, "校准记录.txt"), join(root, "sample.png"), join(root, "old.doc")];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: chosen });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, (event, ...args) => handler(channel === "desktop:attachments-choose" || channel === "desktop:attachment-preview" ? { sender: nativeWindow.webContents, senderFrame: nativeWindow.webContents.mainFrame } : event, ...args));
app.on("browser-window-created", (_event, created) => {
  created.hide(); created.on("show", () => created.hide()); created.webContents.setBackgroundThrottling(false);
  if (nativeWindow) return; nativeWindow = created;
  created.webContents.once("did-finish-load", () => {
    window = new BrowserWindow({ width: 1120, height: 820, show: false, webPreferences: { preload: join(project, "desktop", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    const originalSend = created.webContents.send.bind(created.webContents);
    created.webContents.send = (channel, ...args) => { originalSend(channel, ...args); if (!window.isDestroyed()) window.webContents.send(channel, ...args); };
    window.webContents.once("did-finish-load", () => void verify().then(() => app.quit()).catch(async error => {
      console.error(error); try { console.error("CHAT_FILES_UI " + JSON.stringify(await js("({errors:window.chatFileErrors,status:document.querySelector('#status').textContent,messages:document.querySelector('#messages').textContent,attachments:document.querySelector('#attachment-list').textContent})"))); await shot(`failure-${phase}`); } catch (captureError) { console.error(captureError); } app.exit(1);
    }));
    void window.loadFile(join(project, "desktop", "renderer", "index.html"));
  });
});
const js = code => window.webContents.executeJavaScript(code);
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
async function verify() {
  console.log(`CHAT_FILES_PROGRESS ${phase} window ready`);
  await js(`window.chatFileErrors=[];addEventListener('error',e=>chatFileErrors.push(e.message));addEventListener('unhandledrejection',e=>chatFileErrors.push(String(e.reason)));
    window.waitFile=predicate=>new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(predicate()){clearInterval(timer);resolve();}else if(Date.now()-start>100000){clearInterval(timer);reject(Error('界面等待超时: '+predicate));}},35);});
    waitFile(()=>document.querySelector('#experience-trigger')?.dataset.ready==='true')`);
  assert.equal(await js("document.querySelector('#settings-dialog').open"), false);
  const add = async count => { await js(`document.querySelector('#attach-files').click();waitFile(()=>document.querySelectorAll('#attachment-list .attachment-card').length===${count}&&!document.querySelector('#attach-files').disabled)`); };
  if (phase === "read") {
    const saved = JSON.parse(await readFile(join(root, "chat-file-acceptance.json"), "utf8"));
    const messages = await js(`personalAgent.messages(${JSON.stringify(saved.sessionId)})`);
    const first = messages.find(message => message.role === "user"); assert.equal(first.text, "请阅读并分析所附文件。"); assert.equal(first.attachments.length, 2);
    assert.ok(!first.text.includes("buildme-chat-attachments"));
    await js(`waitFile(()=>[...document.querySelectorAll('.session')].some(button=>button.dataset.id===${JSON.stringify(saved.sessionId)})).then(()=>{[...document.querySelectorAll('.session')].find(button=>button.dataset.id===${JSON.stringify(saved.sessionId)}).click();return waitFile(()=>document.querySelectorAll('#messages .attachment-card').length===2);})`);
    await shot("history-restored"); assert.deepEqual(await js("chatFileErrors"), []); console.log("CHAT_FILES_SMOKE " + JSON.stringify({ phase, restart: true, attachments: 2 })); return;
  }
  await add(2); assert.ok(await js("document.querySelector('#status').textContent.includes('old.doc')"));
  await shot("composer-files-dark");
  await js("document.querySelector('#attachment-list .attachment-open').click();waitFile(()=>document.querySelector('#attachment-preview-content').textContent.includes('DEV-42'))");
  await shot("document-preview-dark"); await js("document.querySelector('#attachment-preview-close').click()");
  await js("document.querySelectorAll('#attachment-list .attachment-open')[1].click();waitFile(()=>!!document.querySelector('#attachment-preview-content img'))");
  await shot("image-preview-dark"); await js("document.querySelector('#attachment-preview-close').click()");
  await js("document.querySelectorAll('#attachment-list .attachment-remove')[1].click()");
  assert.equal(await js("document.querySelectorAll('#attachment-list .attachment-card').length"), 1);
  chosen = [join(root, "sample.png")]; await add(2);
  await js("document.querySelector('#prompt').value='请检查附件中的校准记录和图片。';document.querySelector('#composer').requestSubmit();waitFile(()=>document.querySelector('#send').dataset.running==='false'&&document.querySelector('#messages').textContent.includes('本地测试'))");
  assert.equal(await js("document.querySelector('#attachment-list').hidden"), true);
  assert.equal(await js("document.querySelectorAll('#messages .attachment-card').length"), 2);
  await shot("pi-file-delivery"); console.log("CHAT_FILES_PROGRESS Pi delivered text and image");
  await js("document.querySelector('#full-edition').click();waitFile(()=>document.querySelector('#full-edition').textContent==='DSH 引擎'&&!document.querySelector('#full-edition').disabled)");
  chosen = [join(root, "校准记录.txt"), join(root, "sample.png")]; await add(2);
  await js("document.querySelector('#theme-light').click();waitFile(()=>document.documentElement.dataset.theme==='light')"); await shot("composer-files-light");
  window.setSize(820, 720); await shot("composer-files-compact");
  assert.ok(await js("document.documentElement.scrollWidth<=innerWidth"));
  const geometry = await js("({width:innerWidth,sendRight:document.querySelector('#send').getBoundingClientRect().right,attachLeft:document.querySelector('#attach-files').getBoundingClientRect().left,workspaceLeft:document.querySelector('.workspace').getBoundingClientRect().left})");
  assert.ok(geometry.sendRight <= geometry.width && geometry.attachLeft >= geometry.workspaceLeft, "Upload and send buttons must both fit inside the visible chat area.");
  await js("document.querySelector('#composer').requestSubmit();waitFile(()=>document.querySelector('#send').dataset.running==='false'&&document.querySelector('#messages').textContent.includes('本地测试'))");
  await shot("dsh-file-delivery");
  const sessions = await js("personalAgent.sessions()"); const sessionId = sessions[0].id;
  const messages = await js(`personalAgent.messages(${JSON.stringify(sessionId)})`), user = messages.find(message => message.role === "user");
  assert.equal(user.text, "请阅读并分析所附文件。"); assert.equal(user.attachments.length, 2); assert.ok(user.attachments.some(file => file.previewDataUrl));
  await writeFile(join(root, "chat-file-acceptance.json"), JSON.stringify({ sessionId }));
  assert.deepEqual(await js("chatFileErrors"), []);
  console.log("CHAT_FILES_SMOKE " + JSON.stringify({ phase, pi: true, dsh: true, preview: true, removable: true, fileOnly: true }));
}
void import(pathToFileURL(join(project, "desktop", "main.mjs")).href).catch(error => { console.error(error); app.exit(1); });
