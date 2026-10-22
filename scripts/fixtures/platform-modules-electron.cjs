const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const [, , phase, root, project] = process.argv;
const screenshots = process.env.BUILDME_MODULE_SCREENSHOTS || join(project, "artifacts", "research-modules");
app.setPath("userData", join(root, "user-data")); app.setPath("appData", join(root, "app-data"));
app.commandLine.appendSwitch("force-device-scale-factor", "1"); app.disableHardwareAcceleration();
let window, service;
const calls = { create: 0, revise: 0, record: 0, analyze: 0, saveModule: 0, generateModule: 0 };
const js = code => window.webContents.executeJavaScript(code);
const moduleIds = ["datasets", "code", "comparison", "reports", "samples", "protocols", "experiments", "analysis", "search", "screening", "writing"];
async function shot(name, scrollToTop = true) {
  await js(`${scrollToTop ? "document.querySelector('.platform-content').scrollTop=0;" : ""}new Promise(resolve=>setTimeout(resolve,350))`);
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  assert.ok(image.toPNG().length > 8000); await writeFile(join(screenshots, `${name}.png`), image.toPNG());
}
async function key(keyCode) {
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  window.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\r" : " " });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await js("new Promise(resolve=>setTimeout(resolve,80))");
}
async function checkFits(label) {
  const geometry = await js(`(() => {
    const box=node=>{const b=node.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
    return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,content:box(document.querySelector('.platform-content')),contentWidth:document.querySelector('.platform-content').scrollWidth,library:box(document.querySelector('.platform-module-library')),cards:[...document.querySelectorAll('.platform-module-card,.platform-custom-module-card')].map(box),icons:[...document.querySelectorAll('.platform-module-icon')].map(box),assembly:box(document.querySelector('.platform-assembly')),canvas:box(document.querySelector('.platform-assembly-canvas')),svg:box(document.querySelector('.platform-assembly-svg')),blocks:[...document.querySelectorAll('.platform-assembly-block')].map(box),save:box(document.querySelector('.platform-assembly-footer .platform-primary'))};
  })()`);
  assert.ok(geometry.documentWidth <= geometry.width, `${label}: viewport must fit`);
  assert.ok(geometry.contentWidth <= geometry.content.width + 1, `${label}: module content must not overflow horizontally`);
  for (const card of geometry.cards) {
    assert.ok(card.width > 140 && card.height >= 65, `${label}: choices need readable sizes`);
    assert.ok(card.height < 180, `${label}: choices must stay compact enough to scan`);
    assert.ok(card.left >= geometry.library.left - 1 && card.right <= geometry.library.right + 1, `${label}: choices fit library`);
  }
  for (const icon of geometry.icons) assert.ok(icon.width > 15 && icon.width < 70 && icon.height < 80, `${label}: brick icons must use module styling`);
  if (geometry.width >= 900) assert.ok(geometry.library.right <= geometry.assembly.left + 1, `${label}: assembly must stay beside module choices`);
  if (geometry.width >= 900 && geometry.blocks.length) assert.ok(geometry.save.top >= 0 && geometry.save.bottom <= geometry.height, `${label}: save action must be visible without scrolling`);
  for (const block of geometry.blocks) assert.ok(block.left >= geometry.svg.left - 2 && block.right <= geometry.svg.right + 2 && block.top >= geometry.svg.top - 2 && block.bottom <= geometry.svg.bottom + 2, `${label}: assembled brick must fit its SVG canvas`);
  for (const block of geometry.blocks) assert.ok(block.left >= geometry.canvas.left - 2 && block.right <= geometry.canvas.right + 2 && block.top >= geometry.canvas.top - 2 && block.bottom <= geometry.canvas.bottom + 2, `${label}: brick must not be clipped by canvas; ${JSON.stringify({ block, canvas: geometry.canvas, svg: geometry.svg })}`);
  assert.ok(geometry.assembly.left >= geometry.content.left - 1 && geometry.assembly.right <= geometry.content.right + 1, `${label}: assembly fits content`);
}
async function verify() {
  await js(`window.moduleErrors=[];addEventListener('error',e=>moduleErrors.push(e.message));addEventListener('unhandledrejection',e=>moduleErrors.push(String(e.reason)));
    window.waitModule=predicate=>new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(predicate()){clearInterval(timer);resolve();}else if(Date.now()-start>15000){clearInterval(timer);reject(Error('模块界面超时: '+predicate));}},25);});
    window.clickModule=id=>{const button=document.querySelector('.platform-module-card[data-module-id="'+id+'"]');if(!button)throw Error('缺少模块 '+id);button.click();};
    window.clickText=text=>{const scope=document.querySelector('dialog[open]')||document.querySelector('.platform-panel');const button=[...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!button||button.disabled)throw Error('按钮不可用 '+text);button.click();};
    window.assemblyIds=()=>[...document.querySelectorAll('.platform-assembly-item')].map(item=>item.dataset.moduleId);
    window.setModuleInput=(label,value)=>{const field=document.querySelector('[aria-label="'+label+'"]');if(!field)throw Error('缺少输入 '+label);field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));};
    window.moduleReady=[];
    window.finishModuleSave=async before=>{await waitModule(()=>!document.querySelector('dialog')&&document.querySelector('.platform-panel').hidden&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false'&&moduleReady.length===before+1);const ready=moduleReady.at(-1),state=await moduleFixture.platformState();if(!ready.panelHidden||ready.shellInert||JSON.stringify(ready.snapshot)!==JSON.stringify(state.snapshot)||ready.snapshot.definition.id!==state.activePlatformId)throw Error('保存后必须启用平台、关闭搭建器并将当前快照交给对话');};
    window.saveModules=async()=>{const before=moduleReady.length;clickText('保存并进入对话');if(!document.querySelector('dialog')?.open||document.querySelector('dialog button[type=submit]').textContent!=='保存并进入对话')throw Error('需要审阅再保存并进入对话');document.querySelector('dialog form').requestSubmit();await finishModuleSave(before);};
    window.reviseModules=async()=>{const before=moduleReady.length;clickText('保存变更并进入对话');document.querySelector('dialog form').requestSubmit();await finishModuleSave(before);};
    window.platformUi=createPlatforms(moduleFixture,{onReady:snapshot=>moduleReady.push({snapshot,panelHidden:document.querySelector('.platform-panel').hidden,shellInert:document.querySelector('.app-shell').inert})});platformUi.open()`);
  if (phase === "read") {
    const result = JSON.parse(await readFile(join(root, "module-acceptance.json"), "utf8")), state = await service.state();
    assert.equal(state.activePlatformId, result.platformId); assert.deepEqual(state.snapshot.definition.modules, ["analysis", "writing"]);
    assert.equal(state.snapshot.records.length, 1); assert.equal(state.snapshot.records[0].values.custom_field, "原始样本值");
    assert.ok(state.moduleCatalog.some(module => module.id === result.manualModuleId && module.title === "我的设备校准模块"));
    assert.ok(state.moduleCatalog.some(module => module.id === result.aiModuleId && module.title === "我调整后的 AI 模块"));
    const manualState = await service.select(result.manualPlatformId);
    assert.deepEqual(manualState.snapshot.definition.modules, [result.manualModuleId, "samples"]);
    assert.equal(manualState.snapshot.definition.customModules[0].id, result.manualModuleId);
    assert.equal(manualState.snapshot.records[0].values[result.manualFieldId], "设备-001");
    await service.select(result.platformId);
    await js(`document.querySelector('.platform-picker').value=${JSON.stringify(result.platformId)};document.querySelector('.platform-picker').dispatchEvent(new Event('change'));waitModule(()=>document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')`);
    await js("clickText('继续搭建');waitModule(()=>document.querySelector('.platform-assembly-item'))");
    assert.deepEqual(await js("assemblyIds()"), ["analysis", "writing"]);
    await shot("modules-restored");
    assert.deepEqual(await js("moduleErrors"), []);
    console.log("MODULES_SMOKE " + JSON.stringify({ phase, persistence: true, preservedRemovedRecords: true, customModuleCatalogRestored: true, customRecordsRestored: true })); return;
  }
  assert.deepEqual(await js("[...document.querySelectorAll('.platform-module-card')].map(b=>b.dataset.moduleId)"), moduleIds);
  assert.ok(await js("!!document.querySelector('#platform-custom-module.platform-custom-module-card')"));
  assert.equal(await js("document.querySelector('.platform-page').textContent.includes('更多搭建方式')"), false);
  assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='保存并进入对话').disabled"), true);
  await checkFits("1400 dark empty"); await shot("modules-empty-dark");
  await js("document.querySelector('#platform-custom-module').scrollIntoView({block:'center'})"); await shot("custom-module-tile-dark", false);
  await js("setModuleInput('平台名称','我的积木科研台');document.querySelector('.platform-module-card[data-module-id=analysis]').focus()");
  await key("Enter"); assert.deepEqual(await js("assemblyIds()"), ["analysis"]);
  await js("document.querySelector('.platform-module-card[data-module-id=writing]').focus()");
  await key("Space"); assert.deepEqual(await js("assemblyIds()"), ["analysis", "writing"]);
  await js("document.querySelector('.platform-assembly-block[data-module-id=writing]').focus()");
  await key("Space"); assert.deepEqual(await js("assemblyIds()"), ["analysis"]);
  await js("clickModule('writing');clickModule('samples')");
  await checkFits("1400 dark assembled"); await shot("modules-assembled-dark");
  await js("document.documentElement.dataset.theme='light'"); await checkFits("1400 light assembled"); await shot("modules-assembled-light");
  window.setSize(900, 760); await checkFits("900 light assembled"); await shot("modules-assembled-compact");
  window.setSize(560, 760); await checkFits("560 light assembled"); await shot("modules-assembled-narrow");
  window.setSize(1400, 900); await js("document.documentElement.dataset.theme='dark'");
  await js("document.querySelector('button[aria-label=上移样本管理]').click()");
  assert.deepEqual(await js("assemblyIds()"), ["analysis", "samples", "writing"]);
  assert.equal(calls.create, 0);
  await js("saveModules()"); assert.equal(calls.create, 1);
  let state = await service.state();
  assert.deepEqual(state.snapshot.definition.modules, ["analysis", "samples", "writing"]);
  assert.ok(state.snapshot.definition.pages.every(p => ["analysis", "samples", "writing"].includes(p.moduleId)));
  const source = state.snapshot.definition.pages.find(p => p.moduleId === "samples");
  const original = structuredClone(state.snapshot.definition), custom = { id: "custom_field", label: "自己的字段", type: "text" };
  original.pages.find(p => p.id === source.id).fields.push(custom);
  await service.revise({ id: state.activePlatformId, expectedVersion: state.snapshot.definitionVersion, definition: original });
  await service.record({ pageId: source.id, values: { ...Object.fromEntries(source.fields.filter(f => f.required).map(f => [f.id, "样本-01"])), custom_field: "原始样本值" }, source: "user" });
  await js("platformUi.open();waitModule(()=>!document.querySelector('.platform-panel').hidden&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')");
  await js("clickText('继续搭建');clickModule('samples');clickModule('samples')");
  await js("reviseModules()"); state = await service.state();
  assert.equal(state.snapshot.definition.pages.filter(p => p.moduleId === "samples").length, 1);
  assert.ok(state.snapshot.definition.pages.find(p => p.id === source.id).fields.some(f => f.id === custom.id));
  await js("platformUi.open().then(()=>{clickText('继续搭建');clickModule('samples');return reviseModules();})"); state = await service.state();
  assert.deepEqual(state.snapshot.definition.modules, ["analysis", "writing"]);
  assert.equal(state.snapshot.records.length, 1); assert.equal(state.snapshot.records[0].values.custom_field, "原始样本值");
  assert.equal(calls.record, 0, "Module UI must not rewrite research records.");
  const acceptance = { platformId: state.activePlatformId, definitionVersion: state.snapshot.definitionVersion, checks: ["eleven named module choices", "empty selection disables saving", "native Enter/Space on module cards", "Space removes SVG brick", "assembly order persists", "review before creation", "saving creates or revises then closes the builder and provides the active snapshot to chat", "module pages and capabilities persist", "temporary deselection retains edited fields", "removed module preserves records", "restart restores module selection", "dark/light and 900px/560px layout"] };
  await writeFile(join(root, "module-acceptance.json"), JSON.stringify(acceptance));
  await js("platformUi.open().then(()=>{clickText('我的平台');if(assemblyIds().length)clickText('清空积木');})");
  for (const id of moduleIds) await js(`clickModule('${id}')`);
  assert.equal(await js("document.querySelectorAll('.platform-assembly-block').length"), 11);
  await checkFits("1400 eleven assembled");
  await shot("modules-all-eleven-dark");
  await js("clickText('清空积木');setModuleInput('平台名称','独立数据分析验收台');clickModule('analysis');saveModules()");
  const independent = await service.state(), analysis = independent.snapshot.definition.pages.find(p => p.kind === "analysis"), analysisSource = independent.snapshot.definition.pages.find(p => p.id === analysis.sourcePageId);
  assert.deepEqual(independent.snapshot.definition.modules, ["analysis"]);
  assert.ok(independent.snapshot.definition.pages.every(p => p.moduleId === "analysis"));
  await service.record({ pageId: analysisSource.id, values: { ...Object.fromEntries(analysisSource.fields.filter(f => f.required).map(f => [f.id, f.type === "number" ? 10 : "独立样本-01"])), [analysis.valueField]: 10 }, source: "user" });
  await js(`platformUi.open();waitModule(()=>!document.querySelector('.platform-panel').hidden&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')`);
  await js(`clickText(${JSON.stringify(analysis.title)});clickText('运行分析');waitModule(()=>document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')`);
  const analyzed = await service.state();
  assert.equal(analyzed.snapshot.runs.at(-1).result.rows[0].mean, 10);
  assert.equal(calls.analyze, 1);
  acceptance.checks.push("analysis alone runs real statistics without other modules");
  await js("clickText('我的平台');document.querySelector('#platform-custom-module').click();waitModule(()=>document.querySelector('dialog')?.open)");
  assert.ok(await js("document.querySelector('dialog').textContent.includes('自己设计')&&!!document.querySelector('[aria-label=描述模块需求]')"));
  await shot("custom-module-options-dark");
  await js("clickText('自己设计');waitModule(()=>document.querySelector('[aria-label=模块名称]'))");
  await js("setModuleInput('模块名称','我的设备校准模块');setModuleInput('模块用途','保存自己的设备校准记录');if(!document.querySelector('[aria-label=页面名称]'))clickText('＋ 添加页面');setModuleInput('页面名称','设备登记');clickText('＋ 添加字段');const fields=document.querySelectorAll('[aria-label=字段名称]');fields[fields.length-1].value='设备编号';fields[fields.length-1].dispatchEvent(new Event('input',{bubbles:true}));");
  await shot("custom-module-manual-editor-dark");
  assert.equal(calls.saveModule, 0); assert.equal(calls.create, 2);
  await js("clickText('使用预览')");
  assert.ok(await js("document.querySelector('.platform-record-form [aria-label=设备编号]')?.disabled"));
  await shot("custom-module-manual-preview-dark");
  await js("clickText('保存模块并加入组合');waitModule(()=>document.querySelector('#platform-custom-module')&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')");
  let customState = await service.state();
  const manualModule = customState.moduleCatalog.find(module => module.title === "我的设备校准模块");
  assert.ok(manualModule); assert.equal(calls.saveModule, 1); assert.equal(calls.create, 2, "Saving a module must not create a platform.");
  assert.deepEqual(await js("assemblyIds()"), [manualModule.id]);
  await js("setModuleInput('平台名称','我的自定义积木平台');clickModule('samples');saveModules()");
  customState = await service.state();
  assert.deepEqual(customState.snapshot.definition.modules, [manualModule.id, "samples"]);
  assert.equal(customState.snapshot.definition.customModules[0].id, manualModule.id);
  const manualPage = customState.snapshot.definition.pages.find(page => page.moduleId === manualModule.id);
  const manualField = manualPage.fields.find(field => field.label === "设备编号");
  assert.ok(manualField);
  const manualPlatformId = customState.activePlatformId;
  await js("platformUi.open()");
  await js(`clickText(${JSON.stringify(manualPage.title)});clickText('＋ 新增记录');${manualPage.fields.filter(field => field.required || field.id === manualField.id).map(field => `setModuleInput(${JSON.stringify(field.label + (field.unit ? ` (${field.unit})` : "") + (field.required ? " *" : ""))},${JSON.stringify(field.id === manualField.id ? "设备-001" : "我的校准记录")});`).join("")}document.querySelector('dialog form').requestSubmit();waitModule(()=>!document.querySelector('dialog')&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')`);
  customState = await service.state();
  assert.equal(customState.snapshot.records.length, 1);
  assert.equal(customState.snapshot.records[0].values[manualField.id], "设备-001");
  assert.equal(customState.snapshot.records[0].source, "user"); assert.equal(calls.record, 1);
  await shot("custom-module-real-record-dark");
  await js("clickText('我的平台');document.querySelector('#platform-custom-module').click();setModuleInput('描述模块需求','我需要一个设备校准模块，记录设备编号与校准读数。');document.querySelector('dialog form').requestSubmit();waitModule(()=>!document.querySelector('dialog')&&document.querySelector('[aria-label=模块名称]')&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')");
  assert.equal(calls.generateModule, 1); assert.equal(calls.saveModule, 1);
  assert.equal((await service.state()).moduleCatalog.length, 12, "AI preview must not persist a module.");
  assert.equal(await js("document.querySelector('[aria-label=积木颜色]').value"), "#649b78", "AI module colors must remain visible and selected in the editor.");
  await js("setModuleInput('模块名称','我调整后的 AI 模块');clickText('使用预览')");
  assert.ok(await js("document.querySelector('.platform-record-form [name=equipment]')?.disabled"));
  await shot("custom-module-ai-editable-preview-dark");
  await js("document.documentElement.dataset.theme='light'"); await shot("custom-module-ai-editable-preview-light");
  window.setSize(560, 760); await shot("custom-module-ai-editable-preview-narrow");
  assert.ok(await js("document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.platform-content').scrollWidth<=document.querySelector('.platform-content').clientWidth+1"));
  window.setSize(1400, 900); await js("document.documentElement.dataset.theme='dark';clickText('保存模块并加入组合');waitModule(()=>document.querySelector('#platform-custom-module')&&document.querySelector('.platform-panel').getAttribute('aria-busy')==='false')");
  const aiModule = (await service.state()).moduleCatalog.find(module => module.title === "我调整后的 AI 模块");
  assert.ok(aiModule); assert.equal(calls.saveModule, 2); assert.equal(calls.create, 3);
  acceptance.manualModuleId = manualModule.id; acceptance.aiModuleId = aiModule.id;
  acceptance.manualPlatformId = manualPlatformId; acceptance.manualFieldId = manualField.id;
  acceptance.checks.push("custom module plus tile replaces duplicate build cards", "manual module page and field design", "module save does not create platform", "custom and builtin modules compose and preserve portable definition", "real custom-field record save", "fixture-only AI preview stays unsaved and editable", "explicit AI module save", "restart restores custom module catalog and records");
  await service.select(acceptance.platformId);
  await writeFile(join(root, "module-acceptance.json"), JSON.stringify(acceptance));
  assert.deepEqual(await js("moduleErrors"), []);
  console.log("MODULES_SMOKE " + JSON.stringify({ phase, ...calls, preservedRemovedRecords: true, customModules: true, fixtureOnlyAiGeneration: true, screenshots: 14 }));
}

app.whenReady().then(async () => {
  const { PlatformService } = await import(pathToFileURL(join(project, "desktop", "platform-service.mjs")).href);
  service = new PlatformService({ userData: join(root, "user-data"), getWorkspace: async () => join(root, "workspace") });
  const methods = { platformState: "state", platformCreate: "create", platformRevise: "revise", platformSelect: "select", platformRecord: "record", platformAnalyze: "analyze", platformModuleSave: "saveModule" };
  for (const [api, method] of Object.entries(methods)) ipcMain.handle(`module-fixture:${api}`, async (_event, input) => { if (method in calls) calls[method]++; return service[method](input); });
  const { validateResearchModule } = await import(pathToFileURL(join(project, "desktop", "platform-modules.mjs")).href);
  // Fixture-only deterministic model response. Production uses the configured AI
  // generator; this isolated UI acceptance must never spend model credits.
  ipcMain.handle("module-fixture:platformModuleGenerate", async (_event, input) => {
    assert.ok(input.requirement.includes("设备")); calls.generateModule++;
    return { module: validateResearchModule({ id: "custom_fixture_ai", title: "AI 设备校准模块（测试响应）", description: "仅用于界面验收的模型响应", group: "自定义", color: "#649b78", capabilities: ["records", "files"], pages: [{ id: "calibration", title: "设备校准", kind: "records", fields: [{ id: "equipment", label: "设备编号", type: "text", required: true }, { id: "reading", label: "校准读数", type: "number", unit: "mg/L" }] }] }), explanation: "测试模型响应，尚未保存。" };
  });
  const html = `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8"><base href="${pathToFileURL(join(project, "desktop", "renderer") + "/").href}"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="platforms.css"><link rel="stylesheet" href="platform-modules.css"></head><body><div class="app-shell"></div><script src="platforms.js"></script></body></html>`;
  await writeFile(join(root, "module-fixture.html"), html);
  window = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { preload: join(project, "scripts", "fixtures", "platform-modules-electron-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(join(root, "module-fixture.html"));
  try { await verify(); app.exit(0); } catch (error) { console.error(error); try { console.error("MODULES_UI " + JSON.stringify(await js("({errors:window.moduleErrors,notice:document.querySelector('.platform-notice')?.textContent,dialogError:document.querySelector('.platform-dialog-error')?.textContent,buttons:[...document.querySelectorAll('button')].map(b=>b.textContent.trim()),selected:window.assemblyIds?.()})"))); await shot(`failure-${phase}`); } catch (captureError) { console.error(captureError); } app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
