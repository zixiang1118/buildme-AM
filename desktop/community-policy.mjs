export function communityOrigin(value) {
  if(value==='')return '';
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('社区网址需为 HTTPS 站点根地址；本地开发可用 HTTP。');
  return url.origin;
}
export function navigationPolicy(origin) {
  let github=false;
  return {allowed(raw) {
    const url=new URL(raw);
    if(url.origin===origin) {github=url.pathname==='/auth/github';return true;}
    return github&&url.origin==='https://github.com';
  },completed(raw) {if(new URL(raw).origin===origin)github=false;}};
}
export function embedUrl(origin,path,theme) {const url=new URL(path,origin);if(url.origin!==origin)throw new Error('社区地址不正确');url.searchParams.set('embed','1');url.searchParams.set('theme',theme);return url.href;}
export function unreadFromTitle(title) {const m=/^\((\d{1,6})\) /.exec(title);return m?Math.min(Number(m[1]),999):0;}
export function compareShare({group,metrics}) {
  if(group.kind!=='harness'||!group.rounds.length||Object.values(group.rounds.at(-1).runs).some(r=>r.status!=='done'))throw new Error('请完成一次 Pi / DSH 对比后再分享。');
  const values=side=>{const m=metrics[side];if(['modelCalls','toolCalls','tokens','durationMs'].some(k=>!Number.isFinite(m[k])||m[k]<0))throw new Error('这次对比的统计尚不完整，无法分享。');return {llmCalls:m.modelCalls,toolCalls:m.toolCalls,tokens:m.tokens,seconds:Math.round(m.durationMs/10)/100};};
  const known={spawn_agent:'子 Agent',web_search:'联网搜索',web_fetch:'网页阅读',bash:'终端命令',read_file:'读取文件',write_file:'写入文件',edit_file:'编辑文件'};
  const unique=metrics.right.tools.filter(name=>!metrics.left.tools.includes(name));
  return {v:1,model:group.sides.left.connection.model,pi:{capabilities:group.sides.left.capabilities.length,...values('left')},dsh:values('right'),dshOnly:[...new Set(unique.map(name=>known[name]||(/^[A-Za-z0-9_-]{1,12}$/.test(name)?name:'其他工具')))].slice(0,8)};
}
export function achievementShare(snapshot,definitions,id) {
  const definition=definitions.find(x=>x.id===id);
  if(!definition||!snapshot.achievements.some(x=>x.id===id))throw new Error('这项成就尚未解锁。');
  return {v:1,id:definition.id,name:definition.name,unlocked:snapshot.achievements.length,total:definitions.length};
}
export function shareUrl(origin,type,data,theme) {const url=new URL(embedUrl(origin,`/new?type=${type}`,theme));url.hash=Buffer.from(JSON.stringify(data)).toString('base64url');return url.href;}
