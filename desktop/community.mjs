import { WebContentsView, nativeTheme, shell } from 'electron';
import { embedUrl, navigationPolicy, unreadFromTitle } from './community-policy.mjs';
export function createCommunity(window) {
  let view,origin='',policy,visible=false,failed=false,bounds={x:240,y:110,width:800,height:600};
  const send=payload=>window.webContents.send('desktop:community-state',payload);
  const theme=()=>nativeTheme.shouldUseDarkColors?'dark':'light';
  const external=raw=>{const url=new URL(raw);if(['https:','http:','mailto:'].includes(url.protocol))void shell.openExternal(url.href);};
  const navigation=(event,url)=>{if(!policy.allowed(url)){event.preventDefault();external(url);}};
  const load=url=>{failed=false;send({loading:true,error:''});view.setVisible(visible);return view.webContents.loadURL(url).catch(error=>{if(error.code==='ERR_ABORTED')return;failed=true;view.setVisible(false);send({loading:false,error:'社区暂时无法连接，请检查网络后重试。'});});};
  function ensure(base) {
    if(view && origin===base)return;
    if(view){window.contentView.removeChildView(view);view.webContents.close();}
    origin=base;policy=navigationPolicy(origin);
    view=new WebContentsView({webPreferences:{partition:'persist:community',nodeIntegration:false,contextIsolation:true,sandbox:true}});
    const wc=view.webContents;
    wc.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));wc.session.setPermissionCheckHandler(()=>false);
    wc.on('will-navigate',navigation);wc.on('will-redirect',navigation);
    wc.on('will-frame-navigate',(event)=>{if(!event.isMainFrame)event.preventDefault();});
    wc.setWindowOpenHandler(({url})=>{if(new URL(url).origin===origin)void load(url);else external(url);return {action:'deny'};});
    wc.on('did-start-loading',()=>send({loading:true}));
    wc.on('did-stop-loading',()=>send({loading:false}));
    wc.on('did-navigate',(_event,url)=>{policy.completed(url);});
    wc.on('page-title-updated',(_event,title)=>{if(new URL(wc.getURL()).origin===origin)send({unread:unreadFromTitle(title)});});
    wc.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){failed=true;view.setVisible(false);send({loading:false,error:'社区暂时无法连接，请检查网络后重试。'});}});
    window.contentView.addChildView(view);view.setBounds(bounds);view.setVisible(false);
  }
  const syncTheme=()=>{if(view&&!failed&&new URL(view.webContents.getURL()||origin).origin===origin)void load(embedUrl(origin,view.webContents.getURL()||'/',theme()));};
  nativeTheme.on('updated',syncTheme);
  return {
    open(base,url) {if(!base)return false;ensure(base);visible=true;view.setVisible(!failed);if(url||!view.webContents.getURL()||failed)return load(url||embedUrl(origin,'/',theme()));send({loading:false,error:''});return true;},
    hide(){visible=false;view?.setVisible(false);},
    resize(value) {if(!value||['x','y','width','height'].some(k=>!Number.isFinite(value[k])||value[k]<0||value[k]>20000))throw new Error('社区视图尺寸无效');bounds=Object.fromEntries(Object.entries(value).filter(([k])=>['x','y','width','height'].includes(k)).map(([k,v])=>[k,Math.round(v)]));view?.setBounds(bounds);},
    reset(){if(view){window.contentView.removeChildView(view);view.webContents.close();view=undefined;}send({unread:0});},
    dispose(){nativeTheme.removeListener('updated',syncTheme);view?.webContents.close();},
  };
}
