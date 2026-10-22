import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types.js';
import { limit } from './auth.js';
type Entry={html:string;expires:number};
export function publicCache():MiddlewareHandler<Env> {
 const cache=new Map<string,Entry>(),pending=new Map<string,Promise<Entry|undefined>>();let revision=-1;
 return async(c,next)=>{
  if(c.req.path==='/search')limit(c.get('db'),'search',c.get('ipKey'),30,60000,c.get('now'));
  if(c.req.method!=='GET'||c.get('user')||c.req.header('accept')?.includes('application/json')||!/^\/(?:hot|latest|works|search|p\/\d+)?$/.test(c.req.path)){await next();return;}
  const version=(c.get('db').prepare('SELECT version FROM content_revision WHERE id=1').get() as {version:number}).version;
  if(version!==revision){cache.clear();revision=version;}
  const key=JSON.stringify([version,c.req.url,c.get('theme'),c.get('embed')]),now=c.get('now');
  const reuse=(entry:Entry)=>{if(c.req.path.startsWith('/p/'))c.get('db').prepare('UPDATE posts SET views=views+1 WHERE id=?').run(c.req.path.slice(3));return c.html(entry.html.replaceAll('name="csrf" value="__BUILDME_CSRF__"',`name="csrf" value="${c.get('csrf')}"`));};
  const cached=cache.get(key);if(cached&&cached.expires>now)return reuse(cached);
  const waiting=pending.get(key);if(waiting){const entry=await waiting;if(entry)return reuse(entry);await next();return;}
  let resolve!:(entry:Entry|undefined)=>void,entry:Entry|undefined;pending.set(key,new Promise(done=>{resolve=done;}));
  try {
   await next();
   if(c.res.status===200 && c.res.headers.get('content-type')?.includes('text/html')){
    const html=(await c.res.clone().text()).replaceAll(`name="csrf" value="${c.get('csrf')}"`,'name="csrf" value="__BUILDME_CSRF__"');entry={html,expires:now+10000};
    if(cache.size>=128)cache.delete(cache.keys().next().value!);cache.set(key,entry);
   }
  } finally {pending.delete(key);resolve(entry);}
 };
}
