const { app, ipcMain, BrowserWindow, dialog, shell } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const [, , phase, root, project] = process.argv;
app.setPath("userData", join(root, "user-data"));
app.setPath("appData", join(root, "app-data"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
let mainWindow, capture;
const openedAssets = [];
const locatedAssets = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, (event, ...args) => handler(channel.startsWith("desktop:research-") || channel === "desktop:community-hide" ? { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame } : event, ...args));
dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: [options.title.includes("导出") ? join(root, "exports") : options.title.includes("分子结构") ? join(root, "molecules.smi") : join(root, "assay.csv")] });
shell.showItemInFolder = (path) => { assert.ok(path.startsWith(root)); locatedAssets.push(path); };
shell.openPath = async (path) => { assert.ok(path.startsWith(root)); openedAssets.push(path); return ""; };
app.on("browser-window-created", (_event, window) => {
  window.hide(); window.on("show", () => window.hide()); window.webContents.setBackgroundThrottling(false);
  if (mainWindow) return;
  mainWindow = window;
  window.webContents.once("did-finish-load", () => {
    capture = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: join(project, "desktop", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    capture.webContents.once("did-finish-load", () => verify().catch(async (error) => {
      console.error(error);
      try { console.error(await capture.webContents.executeJavaScript("JSON.stringify({errors:window.researchErrors,notice:document.querySelector('.research-notice')?.textContent,form:document.querySelector('.research-form-error')?.textContent})")); await shot("failure"); } catch {}
      app.exit(1);
    }));
    capture.loadFile(join(project, "desktop", "renderer", "index.html"));
  });
});
const js = (code) => capture.webContents.executeJavaScript(code);
async function shot(name) {
  let error;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await js("new Promise(resolve => setTimeout(resolve,300))");
      const image = await capture.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (image.toPNG().length < 8000) throw new Error("Screenshot has no rendered content");
      await writeFile(join(project, "artifacts", "research", `${name}.png`), image.toPNG());
      return;
    } catch (failure) { error = failure; }
  }
  throw error;
}
async function verify() {
  await js(`window.researchErrors=[]; addEventListener('error',e=>researchErrors.push(e.message)); addEventListener('unhandledrejection',e=>researchErrors.push(String(e.reason)));
    window.waitResearch=(f)=>new Promise((res,rej)=>{ const start=Date.now(); const t=setInterval(()=>{if(f()){clearInterval(t);res();}else if(Date.now()-start>25000){clearInterval(t);rej(Error('UI等待超时'));}},50); });
    window.clickResearch=(text,scope='.research-panel')=>{const el=[...document.querySelectorAll(scope+' button')].find(b=>b.querySelector('span')?.textContent.trim()===text||b.textContent.trim()===text);if(!el)throw Error('没有按钮:'+text);el.click();};
    window.fillResearch=(values)=>{for(const[key,value]of Object.entries(values)){const input=document.querySelector('#research-field-'+key);if(!input)throw Error('没有字段:'+key);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('.research-form').requestSubmit();return waitResearch(()=>!document.querySelector('.research-form-dialog')||!document.querySelector('.research-form-error').hidden);};
    waitResearch(()=>document.querySelector('#experience-trigger')?.dataset.ready==='true')`);
  await js("document.querySelector('#research-entry').click();waitResearch(()=>!document.querySelector('.research-panel').hidden && document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  assert.equal(await js("personalAgent.state().then(state => state.experienceMode)"), "research");
  console.log(`RESEARCH_PROGRESS ${phase} opened`);
  if (phase === "read") {
    const state = await js("personalAgent.researchState()");
    assert.equal(state.snapshot.project.title, "桌面科研验收（示例数据）");
    assert.equal(state.snapshot.assays[0].provenance, "imported");
    assert.ok(state.snapshot.sections.length >= 2);
    await js("clickResearch('论文与证据')");
    await shot("paper-restored");
    assert.deepEqual(await js("researchErrors"), []);
    console.log("RESEARCH_PROGRESS persistence verified");
    app.exit(0); return;
  }
  await shot("onboarding");
  await js("clickResearch('建立我的课题');fillResearch({title:'桌面科研验收（示例数据）',objective:'使用明确标注的示例结构和示例读数验证软件流程',target:'软件验收示例体系'})");
  await js("clickResearch('分子库');clickResearch('添加分子');fillResearch({name:'软件测试结构',smiles:'CCO',notes:'仅用于软件验证，不是候选药物',stereo:'无手性'})");
  let state = await js("personalAgent.researchState()");
  assert.equal(state.snapshot.compounds.length, 1);
  await js("clickResearch('计算分子性质');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  state = await js("personalAgent.researchState()");
  assert.ok(state.snapshot.analyses.some((value) => value.compoundId === state.snapshot.compounds[0].id && value.result.ok));
  await shot("compound-properties");
  await js("clickResearch('导入 MOL / SDF');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  state = await js("personalAgent.researchState()");
  assert.equal(state.snapshot.compounds.length, 2);
  assert.ok(state.snapshot.compounds.some((item) => item.provenance === "imported" && item.smiles.startsWith("CCN")));
  if (process.env.BUILDME_VERIFY_RETROSYNTHESIS === "1") {
    await js("clickResearch('添加分子');fillResearch({name:'逆合成软件验收结构',smiles:'CC(=O)Oc1ccccc1C(=O)O',notes:'仅验证模型运行，不代表AD候选药物',stereo:'无手性'})");
    state = await js("personalAgent.researchState()");
    const molecule = state.snapshot.compounds.at(-1);
    await js(`personalAgent.researchMutate({action:'addCompound',data:{id:${JSON.stringify(molecule.id)},provenance:'example'}})`);
    console.log("RESEARCH_PROGRESS actual retrosynthesis started");
    await js(`personalAgent.researchChemistry({action:'retrosynthesis',compoundId:${JSON.stringify(molecule.id)}})`);
    state = await js("personalAgent.researchState()");
    const route = state.snapshot.analyses.find(item => item.compoundId === molecule.id && item.provenance === "predicted");
    assert.ok(route.result.ok && route.result.routes.length > 0);
    assert.ok(route.result.routes.some(tree => tree.children?.length > 0));
    assert.ok(route.assetIds.length >= 5);
    await js("clickResearch('刷新');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
    await shot("retrosynthesis");
    console.log(`RESEARCH_PROGRESS actual retrosynthesis ${route.result.routes.length} trees / ${route.assetIds.length} archived files verified`);
  }
  await js("clickResearch('合成方案');clickResearch('新建方案');fillResearch({title:'软件验收方案',hypothesis:'仅测试版本化记录',steps:'记录示例条件\\n登记示例批次',factors:'条件A与B',controls:'软件测试对照',replicates:'2',sources:'示例，无实际文献'})");
  state = await js("personalAgent.researchState()");
  const compoundId = state.snapshot.compounds[0].id, planId = state.snapshot.plans[0].id;
  await js(`personalAgent.researchMutate({action:'recordRun',data:{planId:${JSON.stringify(planId)},planVersion:1,status:'completed',conditions:'明确标注的软件示例条件',yieldPercent:50,notes:'未开展实际化学反应',provenance:'example'}})`);
  state = await js("personalAgent.researchState()");
  await js(`personalAgent.researchMutate({action:'recordBatch',data:{compoundId:${JSON.stringify(compoundId)},runId:${JSON.stringify(state.snapshot.runs[0].id)},code:'软件示例批次',purityPercent:null,notes:'仅验证记录关联',provenance:'example'}})`);
  await js("clickResearch('实验记录');clickResearch('刷新');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  state = await js("personalAgent.researchState()");
  assert.equal(state.snapshot.batches.length, 1);
  const batchId = state.snapshot.batches[0].id;
  await js(`personalAgent.researchImport({kind:'assay',batchId:${JSON.stringify(batchId)}})`);
  state = await js("personalAgent.researchState()");
  assert.equal(state.snapshot.assays[0].records[4].value, null);
  await js(`personalAgent.researchAnalyze({assayId:${JSON.stringify(state.snapshot.assays[0].id)}})`);
  state = await js("personalAgent.researchState()");
  assert.equal(state.snapshot.analyses.at(-1).result.rows[0].n, 2);
  assert.equal(state.snapshot.analyses.at(-1).result.rows[0].mean, 16);
  await js("clickResearch('表征与活性');clickResearch('刷新');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  await shot("assay-analysis");
  await js("clickResearch('查看原文件');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  assert.ok(openedAssets.length + locatedAssets.length > 0);
  await js("personalAgent.researchDraft({kind:'methods'})");
  await js("personalAgent.researchDraft({kind:'results'})");
  await js("clickResearch('论文与证据');clickResearch('刷新');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  await shot("paper");
  const exported = await js("personalAgent.researchExport()");
  await writeFile(join(root, "export-result.json"), JSON.stringify(exported));
  state = await js("personalAgent.researchState()");
  assert.ok(state.skills.length >= 7 && state.skills.every((skill) => skill.installed));
  assert.deepEqual(await js("researchErrors"), []);
  capture.setSize(900, 700);
  await shot("compact-layout");
  await js("document.querySelector('.research-mode-trigger').click()");
  assert.equal(await js("document.querySelectorAll('.research-mode-option').length"), 3);
  await shot("research-version-menu");
  await js("document.querySelector('.research-mode-option[data-mode=research]').click()");
  assert.equal(await js("document.querySelector('.research-panel').hidden"), false);
  for (const mode of ["learning", "original"]) {
    await js(`document.querySelector('.research-mode-trigger').click();document.querySelector('.research-mode-option[data-mode=${mode}]').click();waitResearch(()=>document.body.dataset.experience==='${mode}' && document.querySelector('.research-panel').hidden && document.querySelector('#experience-trigger').dataset.switching!=='true')`);
    assert.equal(await js("document.querySelector('.app-shell').inert"), false);
    assert.ok(await js("!!document.querySelector('.experience-home')"));
    await js("document.querySelector('#experience-trigger').click();document.querySelector('.experience-option[data-mode=research]').click();waitResearch(()=>document.body.dataset.experience==='research' && document.querySelector('#experience-trigger').dataset.switching!=='true')");
    assert.equal(await js("document.querySelector('.research-panel').hidden"), true);
    await js("document.querySelector('#research-entry').click();waitResearch(()=>!document.querySelector('.research-panel').hidden && document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
    assert.equal((await js("personalAgent.researchState()")).snapshot.project.title, "桌面科研验收（示例数据）");
  }
  const previousProjectId = (await js("personalAgent.researchState()")).activeProjectId;
  await js("clickResearch('示例课题');waitResearch(()=>!!document.querySelector('.research-example-dialog') && document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  assert.equal(await js("document.querySelectorAll('.research-example-dialog .research-example-card').length"), 3);
  await shot("examples-picker");
  for (const key of ["molecule", "optimization", "evidence"]) {
    if (key !== "molecule") await js("clickResearch('示例课题');waitResearch(()=>!!document.querySelector('.research-example-dialog'))");
    await js(`document.querySelector('.research-example-dialog .research-example-card[data-example-key=${key}]').click();waitResearch(()=>!document.querySelector('.research-example-dialog') && document.querySelector('.research-panel').getAttribute('aria-busy')==='false')`);
    const exampleState = await js("personalAgent.researchState()");
    assert.equal(exampleState.exampleProjects.length, 3);
    assert.ok(exampleState.snapshot.project.objective.includes("教学示例"));
    if (key === "molecule") {
      assert.ok(exampleState.snapshot.compounds.some(item => item.provenance === "literature" && item.name.includes("Donepezil")));
      await js("clickResearch('分子库');clickResearch('计算分子性质');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
      await shot("example-molecule");
    } else if (key === "optimization") {
      assert.ok(exampleState.snapshot.runs.some(item => item.status === "failed" && item.provenance === "example"));
      assert.equal(exampleState.snapshot.plans[0].version, 2);
      await js("clickResearch('实验记录')"); await shot("example-optimization");
    } else {
      assert.ok(exampleState.snapshot.assays.some(assay => assay.records.some(record => record.value === null)));
      assert.ok(exampleState.snapshot.analyses.some(item => item.result?.sourceExample === true));
      await js("clickResearch('表征与活性')"); await shot("example-activity");
      await js("clickResearch('论文与证据')"); await shot("example-evidence");
    }
  }
  await js(`personalAgent.researchSelectProject(${JSON.stringify(previousProjectId)})`);
  await js("clickResearch('刷新');waitResearch(()=>document.querySelector('.research-panel').getAttribute('aria-busy')==='false')");
  assert.equal((await js("personalAgent.researchState()")).projects.length, 4);
  await js("clickResearch('返回聊天')");
  assert.equal(await js("document.querySelector('.app-shell').inert"), false);
  console.log("RESEARCH_PROGRESS create / properties / versions / CSV / analysis / paper / export / three version switching / three teaching projects verified");
  app.exit(0);
}
import(pathToFileURL(join(project, "desktop", "main.mjs")).href).catch((error) => { console.error(error); app.exit(1); });
