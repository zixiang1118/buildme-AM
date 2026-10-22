const { app, BrowserWindow, ipcMain } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const [, , root, project, artifacts] = process.argv;
app.setPath("userData", join(root, "user-data")); app.setPath("appData", join(root, "app-data"));
app.commandLine.appendSwitch("force-device-scale-factor", "1"); app.disableHardwareAcceleration();
let nativeWindow, window, active, sequence = 0, lateRefreshDelta;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  if (channel === "desktop:send") return originalHandle(channel, () => new Promise((resolve, reject) => {
    active = { sessionId: `local-stream-${++sequence}`, resolve, reject };
  }));
  if (channel === "desktop:abort") return originalHandle(channel, () => { active.reject(Error("本地验证取消")); return true; });
  if (channel === "desktop:sessions") return originalHandle(channel, async (event, ...args) => {
    if (lateRefreshDelta) {
      const delta = lateRefreshDelta; lateRefreshDelta = undefined;
      await delay(20); emit("text", delta); await delay(20);
    }
    return handler(event, ...args);
  });
  return originalHandle(channel, handler);
};
app.on("browser-window-created", (_event, created) => {
  // Keep the offscreen renderer in its initial active state. Calling hide() on
  // this window marks it invisible and suppresses native animation frames.
  if (created.webContents.isOffscreen()) return;
  created.hide(); created.on("show", () => created.hide()); created.webContents.setBackgroundThrottling(false);
  if (nativeWindow) return; nativeWindow = created;
  created.webContents.once("did-finish-load", () => {
    window = new BrowserWindow({ width: 1120, height: 820, show: false, paintWhenInitiallyHidden: true, webPreferences: { preload: join(project, "desktop", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    window.webContents.setFrameRate(60); window.webContents.startPainting();
    window.webContents.once("did-finish-load", () => void verify().then(() => app.quit()).catch(async error => {
      console.error(error);
      try { console.error("STREAMING_UI " + JSON.stringify(await js("({errors:fixtureErrors,status:document.querySelector('#status').textContent,messages:document.querySelector('#messages').textContent.slice(-2000),metrics:fixtureMetrics})"))); await shot("failure"); } catch (captureError) { console.error(captureError); }
      app.exit(1);
    }));
    void window.loadFile(join(project, "desktop", "renderer", "index.html"));
  });
});
const js = code => window.webContents.executeJavaScript(code);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const emit = (type, delta = "", sessionId = active.sessionId) => window.webContents.send("desktop:stream", { sessionId, type, delta });
async function shot(name) {
  let error;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await delay(200);
      const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      assert.ok(image.toPNG().length > 8000); await writeFile(join(artifacts, `${name}.png`), image.toPNG()); return;
    } catch (failure) { error = failure; }
  }
  throw error;
}
async function start(prompt) {
  active = undefined;
  await js(`fixtureReceivedCount=0;document.querySelector('#new-chat').click();document.querySelector('#prompt').value=${JSON.stringify(prompt)};document.querySelector('#composer').requestSubmit()`);
  for (let attempt = 0; !active && attempt < 200; attempt++) await delay(10);
  assert.ok(active, "Composer must start the intercepted local send.");
  emit("response-start"); return active.sessionId;
}
async function done({ error, cancel = false } = {}) {
  if (cancel) await js("document.querySelector('#send').click()");
  else if (error) active.reject(Error(error));
  else active.resolve({ sessionId: active.sessionId, text: "本地流式验证完成" });
  await js("waitFixture(()=>document.querySelector('#send').dataset.running==='false')");
  await delay(100);
}
async function verify() {
  await js(`window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
    window.waitFixture=predicate=>new Promise((resolve,reject)=>{const start=Date.now(),timer=setInterval(()=>{if(predicate()){clearInterval(timer);resolve();}else if(Date.now()-start>30000){clearInterval(timer);reject(Error('界面等待超时: '+predicate));}},15);});
    waitFixture(()=>document.querySelector('#experience-trigger')?.dataset.ready==='true')`);
  assert.equal(await js("document.querySelector('#settings-dialog').open"), false);
  await js(`window.fixtureOriginalRender=window.renderMarkdown;window.fixtureMetrics={renders:0,renderMilliseconds:[],frameIntervals:[],longTasks:[],preservedFirstBlock:true};
    window.fixtureReceivedCount=0;personalAgent.onStream(event=>{if(event.type==='text')fixtureReceivedCount++;});
    window.renderMarkdown=(element,text,...args)=>{const start=performance.now();fixtureOriginalRender(element,text,...args);fixtureMetrics.renders++;fixtureMetrics.renderMilliseconds.push(performance.now()-start);};
    window.fixtureMeasuring=true;let lastFrame;function frame(now){if(fixtureMeasuring&&lastFrame!==undefined)fixtureMetrics.frameIntervals.push(now-lastFrame);lastFrame=now;requestAnimationFrame(frame);}requestAnimationFrame(frame);
    if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(list=>{if(fixtureMeasuring)fixtureMetrics.longTasks.push(...list.getEntries().map(entry=>entry.duration));}).observe({type:'longtask'});`);
  console.log("STREAMING_PROGRESS real renderer ready");
  const text = Array.from({ length: 220 }, (_, index) => `## 科研长回答：第 ${index + 1} 组\n\n${"记录数据来源、实验参数与复核结果。流式输出应保持当前阅读位置，已完成的内容继续可读。".repeat(7)}\n\n| 指标 | 结果 | 说明 |\n| --- | ---: | --- |\n| 样本量 | ${index + 30} | 已复核 |\n| 偏差 | 0.2 | 可重复 |\n\n\`\`\`javascript\nconst sample = ${index};\nconst result = { sample, valid: true };\nconsole.log(result);\n\`\`\`\n\n- 数据来源已记录\n- 条件一致\n- 需要复核的项仍保留\n\n`).join("") + "最终结束标记 STREAM-FINAL-TAIL\n";
  const chunks = text.match(/[\s\S]{1,32}/g);
  assert.ok(text.length >= 100000);
  const sessionId = await start("请生成包含段落、列表、表格和代码的长回答，用于本地滚动验证。");
  let readingTop, readingRetained, resumedAtBottom, capturedFirst = false;
  const streamStart = Date.now();
  for (let index = 0; index < chunks.length; index += 24) {
    for (const delta of chunks.slice(index, index + 24)) emit("text", delta);
    await delay(12);
    if (!capturedFirst && index > 240) {
      await js("waitFixture(()=>!!document.querySelector('#messages .assistant p'));window.fixtureFirstBlock=document.querySelector('#messages .assistant p')"); capturedFirst = true;
    }
    if (index > chunks.length * 0.25 && readingTop === undefined) {
      await js("waitFixture(()=>document.querySelector('#messages').scrollHeight>5000)");
      readingTop = await js("(()=>{const box=document.querySelector('#messages');box.scrollTop=1200;box.dispatchEvent(new Event('scroll'));return box.scrollTop;})()");
      await shot("reading-while-generating");
    }
    if (index > chunks.length * 0.55 && readingRetained === undefined) {
      const position = await js("document.querySelector('#messages').scrollTop");
      readingRetained = Math.abs(position - readingTop) < 3;
      assert.ok(readingRetained, `Scrolling upward must retain reading position: ${readingTop} -> ${position}.`);
      await js("(()=>{const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight;box.dispatchEvent(new Event('scroll'));})()");
    }
    if (index > chunks.length * 0.80 && resumedAtBottom === undefined) {
      await js("waitFixture(()=>chatScroller.isFollowing()&&document.querySelector('#messages').scrollHeight-document.querySelector('#messages').scrollTop-document.querySelector('#messages').clientHeight<3)");
      resumedAtBottom = await js("(()=>{const box=document.querySelector('#messages');return box.scrollHeight-box.scrollTop-box.clientHeight<3;})()");
      assert.ok(resumedAtBottom, "Returning to bottom must resume following new output.");
    }
  }
  await js(`waitFixture(()=>fixtureReceivedCount===${chunks.length})`);
  await done();
  const streamedMilliseconds = Date.now() - streamStart;
  await js("window.fixtureMeasuring=false");
  assert.ok(await js("document.querySelector('#messages .assistant:last-child').textContent.includes('STREAM-FINAL-TAIL')"));
  assert.ok(await js("document.querySelector('#messages .assistant:last-child').querySelectorAll('table').length===220"));
  assert.ok(await js("document.querySelector('#messages .assistant:last-child').querySelectorAll('pre').length===220"));
  const metrics = await js("({...fixtureMetrics,preservedFirstBlock:fixtureFirstBlock===document.querySelector('#messages .assistant p'),scrollBehavior:getComputedStyle(document.querySelector('#messages')).scrollBehavior,bottomDistance:(()=>{const box=document.querySelector('#messages');return box.scrollHeight-box.scrollTop-box.clientHeight;})()})");
  assert.ok(metrics.renders < chunks.length / 10, "Tiny text events must be coalesced into far fewer Markdown renders.");
  assert.ok(metrics.preservedFirstBlock, "Completed paragraph DOM nodes must survive later stream updates.");
  assert.equal(metrics.scrollBehavior, "auto"); assert.ok(metrics.bottomDistance < 3);
  await shot("long-reply-complete");
  console.log("STREAMING_PROGRESS long reply, reading retention, following and final tail verified");
  const canonical = await js(`(()=>{const element=document.createElement('div');fixtureOriginalRender(element,${JSON.stringify(text)});return element.innerHTML===document.querySelector('#messages .assistant:last-child').innerHTML;})()`);
  assert.ok(canonical, "Completed streamed output must equal a complete Markdown render.");
  await start("验证未完成长链接闭合后页面收缩的自动跟随。");
  const beforeLink = Array.from({ length: 12 }, (_, index) => `前置段落 ${index + 1}：${"保留科研过程的说明与可复核数据。".repeat(8)}\n\n`).join("");
  emit("text", `${beforeLink}[短链接](https://example.com/${"segment-".repeat(4000)}`);
  await js("waitFixture(()=>fixtureReceivedCount===1&&document.querySelector('#messages .assistant').textContent.includes('segment-')&&chatScroller.isFollowing()&&document.querySelector('#messages').scrollHeight-document.querySelector('#messages').scrollTop-document.querySelector('#messages').clientHeight<1)");
  const expandedTop = await js("document.querySelector('#messages').scrollTop");
  emit("text", ")\n\n");
  await js("waitFixture(()=>!!document.querySelector('#messages .assistant a')&&chatScroller.isFollowing()&&document.querySelector('#messages').scrollHeight-document.querySelector('#messages').scrollTop-document.querySelector('#messages').clientHeight<1)");
  const clampedTop = await js("document.querySelector('#messages').scrollTop");
  assert.ok(expandedTop > clampedTop + 1000, "Closing the long link must shrink and clamp the viewport.");
  emit("text", `${"后续新增内容保持跟随。\n\n".repeat(50)}LINK-SHRINK-TAIL`);
  await js("waitFixture(()=>document.querySelector('#messages .assistant').textContent.includes('LINK-SHRINK-TAIL')&&chatScroller.isFollowing()&&document.querySelector('#messages').scrollHeight-document.querySelector('#messages').scrollTop-document.querySelector('#messages').clientHeight<1)");
  await done();
  await start("验证长思考面板内部滚动和思考文本节点保持。");
  emit("reasoning", Array.from({ length: 160 }, (_, index) => `思考步骤 ${index + 1}：记录现有证据，分析实验条件与数据来源。\n`).join(""));
  emit("text", `${"正文内容继续生成，并保留思考过程。\n\n".repeat(25)}REASONING-ANSWER-BEGIN\n\n`);
  await js("waitFixture(()=>document.querySelector('.reasoning-content')?.scrollHeight>document.querySelector('.reasoning-content')?.clientHeight&&document.querySelector('#messages .assistant').textContent.includes('REASONING-ANSWER-BEGIN')&&chatScroller.isFollowing()&&document.querySelector('#messages').scrollHeight-document.querySelector('#messages').scrollTop-document.querySelector('#messages').clientHeight<1)");
  const nestedWheelConsumed = await js("(()=>{const pane=document.querySelector('.reasoning-content');window.fixtureReasoningNode=pane.firstChild;pane.scrollTop=120;pane.dispatchEvent(new WheelEvent('wheel',{deltaY:-40,bubbles:true}));return pane.scrollTop>0&&chatScroller.isFollowing();})()");
  assert.ok(nestedWheelConsumed, "An upward wheel inside a scrolled reasoning pane must not detach the outer chat.");
  for (let index = 1; index <= 3; index++) {
    emit("text", `${"正文增量。\n\n".repeat(12)}REASONING-TEXT-ONLY-${index}\n\n`);
    await js(`waitFixture(()=>document.querySelector('#messages .assistant').textContent.includes('REASONING-TEXT-ONLY-${index}')&&chatScroller.isFollowing()&&document.querySelector('#messages').scrollHeight-document.querySelector('#messages').scrollTop-document.querySelector('#messages').clientHeight<1)`);
    assert.ok(await js("fixtureReasoningNode===document.querySelector('.reasoning-content').firstChild"), "Text-only paints must retain the unchanged reasoning text node.");
  }
  await delay(60);
  const detachedTop = await js("(()=>{const pane=document.querySelector('.reasoning-content');pane.scrollTop=0;pane.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}));return document.querySelector('#messages').scrollTop;})()");
  assert.equal(await js("chatScroller.isFollowing()"), false, "Upward wheel at the inner pane's top must detach the outer chat.");
  // A synthetic wheel does not scroll by default. This also checks that an
  // unchanged delayed scroll event cannot override the user's pause intent.
  await js("document.querySelector('#messages').dispatchEvent(new Event('scroll'))");
  await delay(60); assert.equal(await js("chatScroller.isFollowing()"), false);
  emit("text", `${"用户阅读时后续内容仍继续到达。\n\n".repeat(30)}REASONING-PAUSED-TAIL`);
  await js("waitFixture(()=>document.querySelector('#messages .assistant').textContent.includes('REASONING-PAUSED-TAIL'))");
  assert.ok(Math.abs(await js("document.querySelector('#messages').scrollTop") - detachedTop) < 3);
  assert.equal(await js("chatScroller.isFollowing()"), false);
  assert.ok(await js("fixtureReasoningNode===document.querySelector('.reasoning-content').firstChild"));
  await done();
  await start("验证会话列表刷新时在途输出片段仍可显示。"); emit("text", "已经显示的正文\n\n");
  await js("waitFixture(()=>document.querySelector('#messages .assistant').textContent.includes('已经显示'))");
  lateRefreshDelta = "SESSION-REFRESH-TAIL"; await done();
  assert.ok(await js("document.querySelector('#messages .assistant').textContent.includes('SESSION-REFRESH-TAIL')"));
  console.log("STREAMING_PROGRESS shrinking link, nested reasoning wheel, stable reasoning node and refresh tail verified");
  await start("验证取消前最后收到的片段。"); emit("text", "先显示一部分回答\n\n");
  await js("waitFixture(()=>document.querySelector('#messages .assistant').textContent.includes('先显示'))");
  emit("text", "取消前保留 CANCEL-TAIL"); await js("waitFixture(()=>fixtureReceivedCount===2)"); await done({ cancel: true });
  assert.ok(await js("[...document.querySelectorAll('#messages .assistant')].at(-1).textContent.includes('CANCEL-TAIL')"));
  assert.ok(await js("[...document.querySelectorAll('#messages .assistant')].at(-1).textContent.includes('已取消')"));
  await start("验证失败前最后收到的片段。"); emit("text", "先显示一部分回答\n\n");
  await js("waitFixture(()=>document.querySelector('#messages .assistant').textContent.includes('先显示'))");
  emit("text", "失败前保留 ERROR-TAIL"); await js("waitFixture(()=>fixtureReceivedCount===2)"); await done({ error: "本地模拟连接失败" });
  assert.ok(await js("[...document.querySelectorAll('#messages .assistant')].at(-1).textContent.includes('ERROR-TAIL')"));
  assert.ok(await js("[...document.querySelectorAll('#messages .assistant')].at(-1).textContent.includes('本地模拟连接失败')"));
  await start("验证下一轮输出。"); emit("text", "新的回答 NEW-RUN"); emit("text", "旧会话不应串入 OLD-SESSION", sessionId); await js("waitFixture(()=>fixtureReceivedCount===2)"); await done();
  const finalMessage = await js("[...document.querySelectorAll('#messages .assistant')].at(-1).textContent");
  assert.ok(finalMessage.includes("NEW-RUN")); assert.ok(!finalMessage.includes("OLD-SESSION"));
  assert.deepEqual(await js("fixtureErrors"), []);
  const summarize = values => { const sorted = [...values].sort((a, b) => a - b); return { count: values.length, mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length), p95: sorted[Math.floor(sorted.length * .95)] || 0, max: sorted.at(-1) || 0 }; };
  const report = { verifiedAt: new Date().toISOString(), realElectron: true, localStreamOnly: true, hardwareAcceleration: false, characters: text.length, chunks: chunks.length, renders: metrics.renders, streamedMilliseconds,
    renderMilliseconds: summarize(metrics.renderMilliseconds), frameIntervals: summarize(metrics.frameIntervals), longTasks: summarize(metrics.longTasks), scrollBehavior: metrics.scrollBehavior,
    preservedFirstBlock: metrics.preservedFirstBlock, readingRetained, resumedAtBottom, finalTail: true, completedMarkdownMatches: canonical, shrinkingLinkRetainsFollowing: true, nestedWheelConsumed, nestedWheelAtTopDetaches: true, unchangedReasoningNode: true, sessionRefreshTail: true, cancelTail: true, errorTail: true, nextRunIsolated: true,
    note: "Timing is diagnostic for this hidden Electron fixture; it does not guarantee a frame rate on other devices." };
  await writeFile(join(artifacts, "acceptance.json"), JSON.stringify(report, null, 2));
  console.log("STREAMING_ACCEPTANCE " + JSON.stringify(report));
}
void import(pathToFileURL(join(project, "desktop", "main.mjs")).href).catch(error => { console.error(error); app.exit(1); });
