const { app, ipcMain, BrowserWindow, dialog, shell } = require("electron");
const { writeFile, readFile } = require("node:fs/promises");
const { join, resolve, relative, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");

const [, , phase, root, project] = process.argv;
const screenshots = process.env.BUILDME_PLATFORM_SCREENSHOTS || join(project, "artifacts", "platforms");
console.log(`PLATFORMS_PROGRESS ${phase} boot`);
app.setPath("userData", join(root, "user-data"));
app.setPath("appData", join(root, "app-data"));
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

let nativeWindow, captureWindow, modelRequests = 0;
const opened = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, (event, ...args) => {
  if (channel === "desktop:send") { modelRequests++; throw new Error("Desktop platform acceptance must not invoke a model."); }
  const trusted = channel.startsWith("desktop:platform-") || channel === "desktop:community-hide";
  return handler(trusted ? { sender: nativeWindow.webContents, senderFrame: nativeWindow.webContents.mainFrame } : event, ...args);
});
dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [
  options.properties?.includes("openDirectory") ? join(root, "exports") : options.title.includes("模板") ? join(root, "platform-template.json") : join(root, "measurements.csv"),
] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(root, "platform-template.json") });
const assertFixturePath = (filename) => { const rel = relative(resolve(root), resolve(filename)); assert.ok(rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel)); };
shell.showItemInFolder = (filename) => { assertFixturePath(filename); opened.push(filename); };
shell.openPath = async (filename) => { assertFixturePath(filename); opened.push(filename); return ""; };

app.on("browser-window-created", (_event, window) => {
  window.hide(); window.on("show", () => window.hide()); window.webContents.setBackgroundThrottling(false);
  if (nativeWindow) return;
  nativeWindow = window;
  window.webContents.once("did-finish-load", () => {
    captureWindow = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: {
      preload: join(project, "desktop", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      offscreen: true, backgroundThrottling: false,
    } });
    const originalSend = nativeWindow.webContents.send.bind(nativeWindow.webContents);
    nativeWindow.webContents.send = (channel, ...args) => { originalSend(channel, ...args); if (!captureWindow.isDestroyed()) captureWindow.webContents.send(channel, ...args); };
    captureWindow.webContents.once("did-finish-load", () => void verify().catch(async (error) => {
      console.error(error);
      try {
        console.error("PLATFORMS_UI " + JSON.stringify(await js("({errors:window.platformSmokeErrors,notice:document.querySelector('.platform-notice')?.textContent,dialogError:document.querySelector('.platform-dialog-error')?.textContent,status:document.querySelector('#status')?.textContent,currentPlatform:document.querySelector('#platform-current-name')?.textContent,mode:document.body.dataset.experience})")));
        await shot(`failure-${phase}`);
      } catch (captureError) { console.error(captureError); }
      app.exit(1);
    }));
    void captureWindow.loadFile(join(project, "desktop", "renderer", "index.html"));
  });
});

const js = (code) => captureWindow.webContents.executeJavaScript(code);
async function shot(name) {
  let error;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await js("new Promise(resolve => setTimeout(resolve, 300))");
      const image = await captureWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      assert.ok(image.toPNG().length > 8000, "Screenshot must contain a rendered interface.");
      await writeFile(join(screenshots, `${name}.png`), image.toPNG());
      return;
    } catch (failure) { error = failure; }
  }
  throw error;
}

async function verify() {
  await js(`window.platformSmokeErrors=[];
    addEventListener('error',event=>platformSmokeErrors.push(event.message));
    addEventListener('unhandledrejection',event=>platformSmokeErrors.push(String(event.reason)));
    window.waitPlatform=(predicate)=>new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(predicate()){clearInterval(timer);resolve();}else if(Date.now()-started>20000){clearInterval(timer);reject(Error('UI等待超时: '+predicate));}},40);});
    window.clickPlatform=(text,scope='.platform-panel')=>{const button=[...document.querySelectorAll(scope+' button')].find(node=>node.textContent.trim()===text||node.querySelector('strong')?.textContent.trim()===text);if(!button)throw Error('没有按钮: '+text);button.click();};
    window.platformDone=()=>waitPlatform(()=>document.querySelector('.platform-panel')?.getAttribute('aria-busy')==='false');
    window.platformDialogDone=()=>waitPlatform(()=>!document.querySelector('.platform-dialog')||!document.querySelector('.platform-dialog-error')?.hidden);
    window.platformSaved=()=>waitPlatform(()=>document.querySelector('.platform-panel')?.hidden&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false'&&!document.querySelector('.platform-dialog')&&!document.querySelector('.app-shell').inert);
    window.platformSet=(node,value)=>{if(!node)throw Error('输入不存在');node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));};
    waitPlatform(()=>document.querySelector('#experience-trigger')?.dataset.ready==='true')`);
  const state = () => js("personalAgent.platformState()");
  const switchMode = async (mode) => {
    await js(`waitPlatform(()=>document.querySelector('#experience-trigger').dataset.ready==='true'&&document.querySelector('#experience-trigger').dataset.switching!=='true');if(document.querySelector('#experience-menu').hidden)document.querySelector('#experience-trigger').click();document.querySelector('.experience-option[data-mode=${mode}]').click();waitPlatform(()=>document.body.dataset.experience==='${mode}'&&document.querySelector('#experience-trigger').dataset.ready==='true'&&document.querySelector('#experience-trigger').dataset.switching!=='true')`);
    assert.equal(await js("personalAgent.state().then(state=>state.experienceMode)"), mode);
    assert.equal(await js("document.querySelector('#platform-entry').hidden"), mode !== "research");
    assert.equal(await js("getComputedStyle(document.querySelector('#platform-entry')).display==='none'"), mode !== "research");
  };
  const open = async () => js("document.querySelector('#platform-entry').click();waitPlatform(()=>document.querySelector('#platform-manage')&&!document.querySelector('#platform-menu').hidden).then(()=>{document.querySelector('#platform-manage').click();return waitPlatform(()=>!document.querySelector('.platform-panel').hidden&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false');})");
  const currentPlatform = async (name) => {
    const displayed = await js("({name:document.querySelector('#platform-current-name')?.textContent,title:document.querySelector('#platform-current-name')?.title,buttonTitle:document.querySelector('#platform-entry').title})");
    assert.equal(displayed.name, name ? `当前：${name}` : "未启用平台", "Header must show the actual selected platform.");
    if(name) assert.ok((displayed.title || "").includes(name) || displayed.buttonTitle.includes(name), "Tooltip must contain the complete platform name.");
  };
  const theme = async (mode) => {
    await js(`document.querySelector('#theme-${mode}').click();waitPlatform(()=>document.documentElement.dataset.theme==='${mode}')`);
  };
  const headerFits = async (label) => {
    const geometry = await js(`(() => {
      const header=document.querySelector('.workspace-header'),actions=header.querySelector('.header-actions'),entry=document.querySelector('#platform-entry'),settings=document.querySelector('#header-settings');
      const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      return {directChild:entry.parentElement===actions,beforeSettings:entry.nextElementSibling===settings,entry:box(entry),header:box(header),actions:box(actions),title:box(document.querySelector('.conversation-title')),buttons:[...actions.querySelectorAll('button')].filter(node=>getComputedStyle(node).display!=='none'&&!node.hidden&&node.getBoundingClientRect().width>0).map(box),scrollWidth:document.documentElement.scrollWidth,width:innerWidth};
    })()`);
    assert.equal(geometry.directChild, true, `${label}: research entry must be in the header actions.`);
    assert.equal(geometry.beforeSettings, true, `${label}: research entry must be directly before settings.`);
    assert.ok(geometry.scrollWidth <= geometry.width, `${label}: viewport must not overflow.`);
    assert.ok(geometry.entry.width > 40 && geometry.entry.height > 20, `${label}: research entry must be visible.`);
    assert.ok(geometry.actions.left >= geometry.header.left && geometry.actions.right <= geometry.header.right + 1, `${label}: header actions must fit.`);
    assert.ok(geometry.title.right <= geometry.actions.left + 1, `${label}: long title must not overlap actions.`);
    for (let index=0;index<geometry.buttons.length;index++) {
      const button=geometry.buttons[index];
      assert.ok(button.left >= geometry.header.left && button.right <= geometry.header.right + 1 && button.top >= geometry.header.top && button.bottom <= geometry.header.bottom + 1, `${label}: each action must fit in header.`);
      if(index) assert.ok(geometry.buttons[index-1].right <= button.left + 1, `${label}: header buttons must not overlap.`);
    }
  };
  const guide = async ({ screenshot, full = false } = {}) => {
    await js("document.querySelector('#platform-guide-open').focus();document.querySelector('#platform-guide-open').click();waitPlatform(()=>document.querySelector('#platform-guide-dialog')?.open)");
    assert.equal(await js("document.querySelector('#platform-guide-dialog').getAttribute('aria-labelledby')"), "platform-guide-title");
    assert.ok(await js("document.querySelector('#platform-guide-title').textContent.includes('说明')"));
    const sections=await js("[...document.querySelectorAll('#platform-guide-dialog [data-guide-section]')].map(button=>({id:button.dataset.guideSection,text:button.textContent.trim()}))");
    assert.ok(sections.length >= 5, "Usage guide must contain useful Chinese sections.");
    assert.ok(sections.some(section=>section.id==='overview'));
    assert.ok(sections.some(section=>section.id==='faq'));
    if(full) {
      const contents=[];
      for(const section of sections) {
        await js(`document.querySelector('#platform-guide-dialog [data-guide-section="${section.id}"]').click()`);
        contents.push(await js("document.querySelector('#platform-guide-dialog').textContent"));
      }
      const text=contents.join('\n');
      for(const term of ["字段","数据","聊天","流程","确认"]) assert.ok(text.includes(term),`Usage guide must explain ${term}.`);
      await js("document.querySelector('#platform-guide-dialog [data-guide-section=overview]').click()");
    }
    assert.ok(await js("document.documentElement.scrollWidth<=innerWidth"), "Usage guide must fit in viewport.");
    if(screenshot) await shot(screenshot);
    await js("document.querySelector('#platform-guide-close').click();waitPlatform(()=>!document.querySelector('#platform-guide-dialog').open)");
    assert.equal(await js("document.activeElement.id"), "platform-guide-open", "Closing guide must restore focus to its opening button.");
    await js("document.querySelector('#platform-guide-open').click()");
    captureWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    captureWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await js("waitPlatform(()=>!document.querySelector('#platform-guide-dialog').open)");
    assert.equal(await js("document.activeElement.id"), "platform-guide-open");
  };

  if (phase === "read") {
    const fixture = JSON.parse(await readFile(join(root, "platform-acceptance.json"), "utf8"));
    assert.equal(await js("personalAgent.state().then(state=>state.experienceMode)"), "research");
    await currentPlatform(null);
    await open();
    assert.equal((await state()).activePlatformId, null, "Explicitly disabled platform must survive a restart.");
    assert.equal((await state()).snapshot, null);
    await js(`platformSet(document.querySelector('.platform-picker'),${JSON.stringify(fixture.platformId)});platformDone()`);
    const restored = await state();
    assert.equal(restored.activePlatformId, fixture.platformId);
    assert.equal(restored.snapshot.definition.name, "我的科研平台 · 改造后");
    assert.equal(restored.snapshot.definitionVersion, 2);
    assert.equal(restored.snapshot.records.length, fixture.records);
    assert.equal(restored.snapshot.runs.length, fixture.runs);
    await js(`platformSet(document.querySelector('.platform-picker'),${JSON.stringify(fixture.platformId)});platformDone()`);
    await js("clickPlatform('过程与版本')");
    assert.ok(await js("document.querySelectorAll('.platform-run').length>=4"));
    await shot("restored-history");
    assert.deepEqual(await js("platformSmokeErrors"), []);
    assert.equal(modelRequests, 0);
    console.log("PLATFORMS_SMOKE " + JSON.stringify({ phase, persistence: true, disabledPersistence: true, noModelRequests: true }));
    app.exit(0); return;
  }

  assert.equal(await js("personalAgent.state().then(state=>state.experienceMode)"), "original");
  assert.equal(await js("document.querySelectorAll('.experience-option').length"), 3);
  assert.equal(await js("document.querySelector('#platform-entry').hidden"), true);
  for (const mode of ["learning", "research", "original", "research"]) await switchMode(mode);
  await currentPlatform(null);
  const title=await js("document.querySelector('#chat-title').textContent");
  await js("document.querySelector('#chat-title').textContent='用于研究平台标题溢出验收的超长科研对话名称：多组实验数据、实验方案设计与研究记录管理'.repeat(5)");
  await headerFits("1400px dark");
  await shot("research-header-dark");
  await theme("light");
  await headerFits("1400px light");
  await shot("research-header-light");
  await js(`document.querySelector('#chat-title').textContent=${JSON.stringify(title)}`);
  await theme("dark");
  await open();
  assert.equal(await js("document.querySelector('.app-shell').inert"), true);
  await guide({ screenshot:"usage-guide-dark", full:true });
  await theme("light");
  await guide({ screenshot:"usage-guide-light" });
  await theme("dark");
  await shot("my-platforms");

  await js("personalAgent.platformPreview({requirement:'平台名称：桌面自搭科研平台；字段：样品编号、组别、读数(mg/L)、备注。需要统计分析和研究笔记。'}).then(result=>{window.platformAcceptanceDraft=result.definition;clickPlatform('＋ 搭建新平台');clickPlatform('高级配置');platformSet(document.querySelector('.platform-json'),JSON.stringify(result.definition,null,2));clickPlatform('应用配置到预览');})");
  assert.equal((await state()).platforms.length, 0, "Preview must not persist a platform.");
  assert.ok(await js("document.querySelector('.platform-page').textContent.includes('搭建你的科研平台')"));
  await js("clickPlatform('使用预览')");
  assert.equal(await js("document.querySelectorAll('.platform-record-form input,.platform-record-form textarea').length"), 4);
  await shot("build-preview");
  const longPlatformName="桌面自搭科研平台 · 用于检验当前平台名称显示与省略的长期研究课题：不同样品在多组条件下的读数比较和实验记录管理";
  await js(`platformSet(document.querySelector('.platform-basic input'),${JSON.stringify(longPlatformName)})`);
  await js("clickPlatform('保存并进入对话');if(document.querySelector('.platform-dialog button[type=submit]').textContent!=='保存并进入对话')throw Error('保存确认需要说明进入对话');document.querySelector('.platform-dialog form').requestSubmit();platformSaved()");
  let current = await state();
  assert.equal(current.platforms.length, 1);
  assert.equal(current.snapshot.definition.name, longPlatformName);
  await currentPlatform(longPlatformName);
  await js("document.querySelector('#chat-title').textContent='同时检验超长聊天标题和当前科研平台名称'.repeat(10)");
  await headerFits("1400px selected long platform name");
  await shot("research-current-platform");
  captureWindow.setSize(900,700);
  await headerFits("900px selected long platform name");
  await shot("research-current-platform-compact");
  captureWindow.setSize(1400,900);
  await js(`document.querySelector('#chat-title').textContent=${JSON.stringify(title)}`);
  await open();
  const platformId = current.activePlatformId;
  const recordPage = current.snapshot.definition.pages.find((page) => page.kind === "records");
  const analysisPage = current.snapshot.definition.pages.find((page) => page.kind === "analysis");
  const fields = Object.fromEntries(recordPage.fields.map((field) => [field.label, field.id]));
  assert.equal(recordPage.fields.find((field) => field.id === fields.读数).type, "number");
  assert.equal(recordPage.fields.find((field) => field.id === fields.读数).unit, "mg/L");
  await js(`clickPlatform(${JSON.stringify(recordPage.title)});clickPlatform('＋ 新增记录');
    platformSet(document.querySelector('.platform-dialog [name=${fields.样品编号}]'),'手动记录');
    platformSet(document.querySelector('.platform-dialog [name=${fields.组别}]'),'手动');
    platformSet(document.querySelector('.platform-dialog [name=${fields.读数}]'),'0');
    platformSet(document.querySelector('.platform-dialog [name=${fields.备注}]'),'仅用于软件流程验收');
    document.querySelector('.platform-dialog form').requestSubmit();platformDialogDone();platformDone()`);
  current = await state();
  assert.equal(current.snapshot.records[0].source, "user");
  assert.equal(current.snapshot.records[0].values[fields.读数], 0);
  await js(`personalAgent.platformRecord({pageId:${JSON.stringify(recordPage.id)},values:${JSON.stringify({ [fields.样品编号]: "明确标注示例", [fields.组别]: "示例", [fields.读数]: 22 })},source:'example'})`);
  // Refresh the panel through its public close/open lifecycle after a direct IPC action.
  await js("clickPlatform('返回聊天')"); await open(); await js("clickPlatform('平台总览');platformDone()");
  await js(`clickPlatform(${JSON.stringify(recordPage.title)});clickPlatform('导入 CSV / Excel');platformDone()`);
  current = await state();
  assert.equal(current.snapshot.records.length, 7);
  assert.deepEqual([...new Set(current.snapshot.records.map((record) => record.source))].sort(), ["example", "imported", "user"]);
  assert.equal(current.snapshot.records.at(-1).values[fields.读数], null);
  await shot("custom-records");
  await js(`clickPlatform(${JSON.stringify(analysisPage.title)});clickPlatform('运行分析');platformDone()`);
  current = await state();
  const analysis = current.snapshot.runs.at(-1);
  assert.equal(analysis.kind, "descriptive-statistics");
  assert.equal(analysis.result.missing, 1);
  assert.equal(analysis.result.rows.find((row) => row.label === "A").n, 3);
  assert.equal(analysis.result.rows.find((row) => row.label === "A").mean, (12 + 20 + 30) / 3);
  assert.ok(analysis.result.warnings.some((warning) => warning.includes("示例")));
  assert.ok(await js("!!document.querySelector('.platform-chart svg')"));
  await shot("analysis-and-chart");
  await js("document.querySelector('.platform-content').scrollTop=document.querySelector('.platform-content').scrollHeight");
  await shot("analysis-chart-detail");
  console.log("PLATFORMS_PROGRESS custom platform / CSV / actual statistics verified");

  await js("clickPlatform('平台总览');clickPlatform('运行流程');platformDone()");
  current = await state();
  const execution = current.snapshot.runs.at(-1);
  assert.equal(execution.kind, "workflow"); assert.equal(execution.status, "completed");
  assert.deepEqual(execution.stepResults.map((step) => step.step), ["import", "analyze", "report"]);
  assert.ok(current.snapshot.runs.some((run) => run.kind === "report" && run.result.body.includes("3 个样品编号")));
  assert.ok(await js("document.querySelectorAll('.platform-run').length>=4"));
  await js("document.querySelectorAll('.platform-run').forEach(element=>element.open=true)");
  await shot("workflow-evidence");
  await js("clickPlatform('查看原文件');platformDone()"); assert.ok(opened.length > 0);

  await js("clickPlatform('平台总览');clickPlatform('继续搭建');clickPlatform('高级配置')");
  await js(`const edited=JSON.parse(document.querySelector('.platform-json').value);edited.name='我的科研平台 · 改造后';edited.pages.find(page=>page.id===${JSON.stringify(recordPage.id)}).fields=edited.pages.find(page=>page.id===${JSON.stringify(recordPage.id)}).fields.filter(field=>field.id!==${JSON.stringify(fields.备注)});platformSet(document.querySelector('.platform-json'),JSON.stringify(edited,null,2));clickPlatform('应用配置到预览');clickPlatform('保存变更并进入对话');document.querySelector('.platform-dialog form').requestSubmit();platformSaved()`);
  current = await state();
  assert.equal(current.snapshot.definitionVersion, 2);
  await currentPlatform("我的科研平台 · 改造后");
  assert.equal(current.snapshot.history.length, 2);
  assert.equal(current.snapshot.records[0].values[fields.备注], "仅用于软件流程验收");
  assert.ok(current.snapshot.archivedFields.some((field) => field.id === fields.备注));
  await open();
  await shot("platform-after-edit");
  const exported = await js("personalAgent.platformExport()");
  const template = await js("personalAgent.platformTemplateExport()");
  assert.equal(template.path, join(root, "platform-template.json"));
  const templateContent=JSON.parse(await readFile(join(root,"platform-template.json"),"utf8"));
  templateContent.definition.name="导入模板生成的新平台";
  await writeFile(join(root,"platform-template.json"),JSON.stringify(templateContent));
  await js("clickPlatform('我的平台');clickPlatform('导入平台模板');platformDone()");
  const importedTemplate = await state();
  assert.equal(importedTemplate.platforms.length, 2);
  assert.equal(importedTemplate.snapshot.records.length, 0);
  assert.equal(importedTemplate.snapshot.runs.length, 0);
  assert.equal(importedTemplate.snapshot.assets.length, 0);
  assert.notEqual(importedTemplate.activePlatformId,platformId);
  await currentPlatform("导入模板生成的新平台");
  await js(`platformSet(document.querySelector('.platform-picker'),${JSON.stringify(platformId)});platformDone()`);
  await currentPlatform("我的科研平台 · 改造后");
  await js(`clickPlatform('我的平台');document.querySelector('.platform-card[data-platform-id=${JSON.stringify(importedTemplate.activePlatformId)}] .platform-danger').click()`);
  await shot("delete-platform-confirmation");
  await js("clickPlatform('取消','.platform-dialog')");
  assert.equal((await state()).platforms.length, 2, "Cancelling must keep the platform.");
  await js(`document.querySelector('.platform-card[data-platform-id=${JSON.stringify(importedTemplate.activePlatformId)}] .platform-danger').click();document.querySelector('.platform-dialog form').requestSubmit();platformDialogDone();platformDone()`);
  assert.equal((await state()).platforms.length, 1);
  assert.equal((await state()).activePlatformId, platformId, "Deleting an inactive platform must keep the selected platform.");
  await js("clickPlatform('导入平台模板');platformDone()");
  await js("clickPlatform('我的平台')");
  const activeTemplate = await state();
  await js(`document.querySelector('.platform-card[data-platform-id=${JSON.stringify(activeTemplate.activePlatformId)}] .platform-danger').click();document.querySelector('.platform-dialog form').requestSubmit();platformDialogDone();platformDone()`);
  assert.equal((await state()).activePlatformId, null, "Deleting the selected platform must disable platform context.");
  assert.equal((await state()).snapshot, null);
  await currentPlatform(null);
  await js(`platformSet(document.querySelector('.platform-picker'),${JSON.stringify(platformId)});platformDone()`);
  await currentPlatform("我的科研平台 · 改造后");
  await js("clickPlatform('返回聊天')"); await open(); await js("clickPlatform('平台总览');platformDone()");

  // The panel has the same three-mode switcher as the original application.
  for (const mode of ["original", "learning"]) {
    await js(`document.querySelector('.platform-mode-trigger').click();document.querySelector('.platform-mode-option[data-mode=${mode}]').click();waitPlatform(()=>document.body.dataset.experience==='${mode}'&&document.querySelector('.platform-panel').hidden&&document.querySelector('#experience-trigger').dataset.ready==='true'&&document.querySelector('#experience-trigger').dataset.switching!=='true')`);
    assert.equal(await js("document.querySelector('#platform-entry').hidden"), true);
    assert.equal(await js("document.querySelector('.app-shell').inert"), false);
    await switchMode("research"); await open();
    assert.equal((await state()).activePlatformId, platformId);
  }
  captureWindow.setSize(900, 700);
  await js("clickPlatform('返回聊天');document.querySelector('#chat-title').textContent='紧凑窗口中仍应完整显示科研入口与设置，长标题需要截断'.repeat(5)");
  await headerFits("900px dark");
  await shot("research-header-compact-dark");
  await theme("light");
  await headerFits("900px light");
  await shot("research-header-compact-light");
  await open();
  await guide({ screenshot:"usage-guide-compact-light" });
  await theme("dark");
  await js("clickPlatform('平台总览');platformDone()");
  await shot("compact-layout");
  assert.ok(await js("document.documentElement.scrollWidth<=innerWidth"), "Platform panel must not overflow the viewport.");
  assert.deepEqual(await js("platformSmokeErrors"), []);
  assert.equal(modelRequests, 0);
  current = await state();
  await writeFile(join(root, "platform-acceptance.json"), JSON.stringify({ platformId, exportPath: exported.path,
    definitionVersion: current.snapshot.definitionVersion, records: current.snapshot.records.length, runs: current.snapshot.runs.length, assets: current.snapshot.assets.length }));
  await js("clickPlatform('返回聊天');document.querySelector('#platform-entry').click();waitPlatform(()=>document.querySelector('#platform-menu-options button[data-platform-id=\"\"]')?.disabled===false).then(()=>{document.querySelector('#platform-menu-options button[data-platform-id=\"\"]').click();return waitPlatform(()=>document.querySelector('#platform-current-name').textContent==='未启用平台');})");
  await currentPlatform(null);
  assert.equal((await state()).activePlatformId, null);
  await js("document.querySelector('#platform-entry').click();waitPlatform(()=>!document.querySelector('#platform-menu').hidden)");
  await shot("research-platform-selector-disabled");
  console.log("PLATFORMS_SMOKE " + JSON.stringify({ phase, threeModes: true, researchHeader: true, currentPlatform: true, platformDeletion: true, platformDisabling: true, longTitlesFit: true, usageGuide: true, themes: true, customPlatform: true, actualStatistics: true, workflow: true, preservedData: true, configOnlyTemplate: true, noModelRequests: true }));
  app.exit(0);
}

void import(pathToFileURL(join(project, "desktop", "main.mjs")).href).catch((error) => { console.error(error); app.exit(1); });
