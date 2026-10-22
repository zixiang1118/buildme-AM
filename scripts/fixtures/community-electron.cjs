const {app,shell,webContents}=require('electron');
const {join}=require('node:path');const {pathToFileURL}=require('node:url');const assert=require('node:assert/strict');
const [,,phase,root,project]=process.argv;app.setPath('userData',join(root,'user-data'));app.setPath('appData',join(root,'app-data'));
const opened=[];shell.openExternal=async url=>{opened.push(url);};
app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',()=>void verify(window).catch(e=>{console.error(e);app.exit(1);}))); 
async function verify(window) {
 const js=code=>window.webContents.executeJavaScript(code);
 await js(`window.waitUI=predicate=>new Promise((resolve,reject)=>{if(predicate())return resolve();const timeout=setTimeout(()=>{observer.disconnect();reject(Error('UI timeout'));},10000);const observer=new MutationObserver(()=>{if(predicate()){clearTimeout(timeout);observer.disconnect();resolve();}});observer.observe(document.body,{subtree:true,attributes:true,childList:true,characterData:true});});waitUI(()=>document.querySelector('#model-label').textContent!=='选择模型')`);
 if(phase==='write'){
  assert.equal(await js("document.querySelector('#community-entry').disabled"),true);
  await js("document.querySelector('#community-url').value='http://localhost:3198';document.querySelector('#community-save').click();waitUI(()=>!document.querySelector('#community-entry').disabled)");
 }
 await js("document.querySelector('#community-entry').click();void 0");
 assert.equal(await js("document.querySelector('#community-panel').hidden"),false);
 await js("waitUI(()=>document.querySelector('#community-progress').hidden)");
 let remote=webContents.getAllWebContents().find(wc=>wc!==window.webContents&&wc.getURL().startsWith('http://localhost:3198'));
 assert.ok(remote,'community WebContents');
 const rjs=code=>remote.executeJavaScript(code);
 assert.deepEqual(await rjs("[typeof window.personalAgent,typeof require]"),['undefined','undefined']);
 assert.equal(remote.getLastWebPreferences().sandbox,true);assert.equal(remote.getLastWebPreferences().contextIsolation,true);assert.equal(remote.getLastWebPreferences().nodeIntegration,false);
 assert.equal(await rjs("document.documentElement.dataset.embed"),'1');assert.equal(await rjs("getComputedStyle(document.querySelector('.brand')).display"),'none');
 if(phase==='write') {
  await remote.loadURL('http://localhost:3198/login');
  const nav=new Promise(resolve=>remote.once('did-finish-load',resolve));await rjs("document.querySelector('[name=username]').value='浏览器管理员';document.querySelector('[name=password]').value='browser-test-password';document.querySelector('form[action=\"/login\"]').requestSubmit();void 0");await nav;assert.ok(remote.getURL().includes('/latest'));
  await rjs("document.title='(3) 社区';void 0");await js("waitUI(()=>document.querySelector('#community-unread').textContent==='3')");await rjs("document.title='社区';void 0");await js("waitUI(()=>document.querySelector('#community-unread').hidden)");
  const initial=remote.getURL();await rjs("location.href='https://github.com/not-an-oauth-flow';void 0");await new Promise(resolve=>setImmediate(resolve));assert.equal(opened.at(-1),'https://github.com/not-an-oauth-flow');assert.equal(remote.getURL(),initial);
  await rjs("window.open('https://example.com/external');void 0");await new Promise(resolve=>setImmediate(resolve));assert.equal(opened.at(-1),'https://example.com/external');
  const themeNav=new Promise(resolve=>remote.once('did-finish-load',resolve));await js("window.personalAgent.setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark')");await themeNav;assert.equal(new URL(remote.getURL()).searchParams.get('theme'),await rjs("document.documentElement.dataset.theme"));
  await js("window.personalAgent.communityConfig('http://localhost:3197')");await js("window.personalAgent.communityOpen()");await js("waitUI(()=>!document.querySelector('#community-error').hidden)");
  await js("window.personalAgent.communityConfig('http://localhost:3198')");await js("document.querySelector('#community-retry').click();waitUI(()=>document.querySelector('#community-progress').hidden&&document.querySelector('#community-error').hidden)");
  remote=webContents.getAllWebContents().find(wc=>wc!==window.webContents&&wc.getURL().startsWith('http://localhost:3198'));await remote.loadURL('http://localhost:3198/settings');assert.match(await rjs('document.body.textContent'),/账号设置/);
 } else {await remote.loadURL('http://localhost:3198/settings');assert.match(await rjs('document.body.textContent'),/浏览器管理员/);assert.ok(!await rjs("!!document.querySelector('form[action=\"/login\"]')"));}
 console.log('COMMUNITY_SMOKE '+JSON.stringify({phase,checks:phase==='write'?'I-1 I-3 I-4 I-5 I-9 I-10; real login':'I-2 persisted login after full restart'}));await remote.session.flushStorageData();app.quit();
}
void import(pathToFileURL(join(project,'desktop/main.mjs')).href).catch(e=>{console.error(e);app.exit(1);});
