(() => {
  window.createCommunityPanel = api => {
    const entry=document.querySelector('#community-entry'),panel=document.querySelector('#community-panel'),frame=document.querySelector('#community-frame'),bar=document.querySelector('#community-progress'),error=document.querySelector('#community-error'),badge=document.querySelector('#community-unread'),input=document.querySelector('#community-url');
    let enabled=false,active=false;
    const bounds=()=>{const r=frame.getBoundingClientRect();return api.communityBounds({x:r.x,y:r.y,width:r.width,height:r.height});};
    function hide(){active=false;panel.hidden=true;entry.setAttribute('aria-current','false');void api.communityHide();}
    async function show(action=()=>api.communityOpen()) {
      if(!enabled)return;
      for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
      active=true;panel.hidden=false;bar.hidden=false;error.hidden=true;entry.setAttribute('aria-current','page');
      await bounds();
      try{await action();}catch(e){bar.hidden=true;error.hidden=false;error.querySelector('p').textContent=e.message;}
    }
    const sync=state=>{enabled=Boolean(state.communityUrl);entry.disabled=!enabled;entry.querySelector('small').textContent=enabled?'':'即将开放';input.value=state.communityUrl||'';};
    entry.addEventListener('click',()=>void show());document.querySelector('#community-close').addEventListener('click',hide);document.querySelector('#community-retry').addEventListener('click',()=>void show());
    document.querySelector('#community-save').addEventListener('click',async()=>{const notice=document.querySelector('#community-config-status');try{sync({communityUrl:await api.communityConfig(input.value.trim())});hide();notice.textContent='社区网址已保存';}catch(e){notice.textContent=e.message;}});
    for(const id of ['new-chat','session-list','comparisons','achievements','my-agent','settings','header-settings','plugin-market'])document.getElementById(id).addEventListener('click',()=>{if(active)hide();});
    api.onCommunity(state=>{if(state.loading!==undefined)bar.hidden=!state.loading;if(state.error!==undefined){error.hidden=!state.error;error.querySelector('p').textContent=state.error;}if(state.unread!==undefined){badge.textContent=String(state.unread);badge.hidden=!state.unread;}});
    new ResizeObserver(()=>{if(active)void bounds();}).observe(frame);
    const observer=new MutationObserver(()=>{if(active){if(document.querySelector('dialog[open]'))void api.communityHide();else void api.communityOpen();}});
    for(const dialog of document.querySelectorAll('dialog'))observer.observe(dialog,{attributes:true,attributeFilter:['open']});
    window.shareToCommunity=(type,id)=>show(()=>api.communityShare(type,id));
    window.communityAvailable=()=>enabled;
    return {sync,hide};
  };
})();
