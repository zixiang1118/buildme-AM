import type { Context } from 'hono';
import type { Env } from '../types.js';
import type { Post } from '../lib/posts.js';
import { type Reply, reactionsFor } from '../lib/interactions.js';
import { Csrf, Avatar } from './layout.js';

import { ReportForm } from "./admin.js";
export function Reactions({c,kind,id}:{c:Context<Env>;kind:'post'|'reply';id:number}) {
  const user = c.get('user');
  return <div class="reactions" data-reactions>
    {reactionsFor(c.get('db'),kind,id,user?.id ?? 0).map(r=> user ?
      <form method="post" action={`/reactions/${kind}/${id}`} data-reaction class="inline-form">
        <Csrf value={c.get('csrf')}/><input type="hidden" name="emoji" value={r.emoji}/><input type="hidden" name="active" value={r.active?'0':'1'}/>
        <button type="submit" class={`reaction ${r.active?'on':''}`} title={r.names || `添加 ${r.emoji} 回应`} aria-label={`${r.emoji} 回应，${r.count} 人`} aria-pressed={!!r.active}>{r.emoji} <span>{r.count || ''}</span></button>
      </form> : r.count > 0 ? <a class="reaction" href="/login" title={r.names}>{r.emoji} {r.count}</a> : null)}
  </div>;
}
export function Bookmark({c,post}:{c:Context<Env>;post:Post}) {
  const user=c.get('user');
  if(!user) return <a href="/login">登录后收藏</a>;
  const active=!!c.get('db').prepare('SELECT 1 FROM bookmarks WHERE user_id=? AND post_id=?').get(user.id,post.id);
  return <form method="post" action={`/p/${post.id}/bookmark`} data-interaction="bookmark" class="inline-form">
    <Csrf value={c.get('csrf')}/><input type="hidden" name="active" value={active?'0':'1'}/><button type="submit" class="button" aria-pressed={active} data-active-label="取消收藏" data-inactive-label="收藏"><span data-interaction-label>{active?'取消收藏':'收藏'}</span></button>
  </form>;
}
export function ReplyCard({c,post,reply,inline=false}:{c:Context<Env>;post:Post;reply:Reply;inline?:boolean}) {
  const user=c.get('user');
  return <article class="panel reply" id={inline?undefined:String(reply.floor)} data-floor={inline?undefined:reply.floor} data-reply-id={reply.id} tabindex={-1}>
    <header class="post-meta"><Avatar user={reply}/><a href={`/u/${encodeURIComponent(reply.username)}`}>{reply.username}</a>
      {reply.author_id===post.author_id && <span class="tag">楼主</span>}
      <a href={`/p/${post.id}#${reply.floor}`}>#{reply.floor}</a>
      <time>{new Date(reply.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</time>{reply.updated_at && <span>已编辑</span>}
    </header>
    {reply.parent_floor && <a class="reply-parent" href={`/p/${post.id}?page=${Math.ceil(reply.parent_floor/30)}#${reply.parent_floor}`}>回复 #{reply.parent_floor} @{reply.parent_username}</a>}
    <div class="prose" dangerouslySetInnerHTML={{__html:reply.html}}/>
    <Reactions c={c} kind="reply" id={reply.id}/><ReportForm c={c} kind="reply" id={reply.id}/>
    <div class="post-actions">
      {user && <a href={`/p/${post.id}?replyTo=${reply.floor}#reply-form`} data-reply-to={reply.floor} data-username={reply.username}>回复</a>}
      <a href={`/p/${post.id}#${reply.floor}`} data-copy-floor>复制楼层地址</a>
      {user?.id===reply.author_id && <><a href={`/replies/${reply.id}/edit`}>编辑</a><form method="post" action={`/replies/${reply.id}/delete`}><Csrf value={c.get('csrf')}/><button class="button">删除回复</button></form></>}
      {reply.child_count>0 && !inline && <button class="button" type="button" data-children={reply.floor} aria-expanded="false">{reply.child_count} 条回复</button>}
    </div><div data-child-list hidden/>
  </article>;
}
export function ReplyForm({c,post,body='',parentFloor='',reply}:{c:Context<Env>;post:Post;body?:string;parentFloor?:string;reply?:Reply}) {
  return <form id="reply-form" class="panel form" method="post" enctype="multipart/form-data" action={reply?`/replies/${reply.id}/edit`:`/p/${post.id}/reply`}>
    <Csrf value={c.get('csrf')}/><input type="hidden" name="parentFloor" value={parentFloor}/>
    <div id="reply-target">{parentFloor?`回复 #${parentFloor}`:''}</div>
    <label class="field"><span>回复 · Markdown</span><textarea name="body" rows={6} maxlength={10000} required>{body}</textarea></label>
    <label class="field"><span>插入图片</span><input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif"/></label>
    <div class="form-actions"><button class="button" name="action" value="upload" formnovalidate>上传并插入图片</button><button class="button" name="action" value="preview">预览回复</button><button class="button primary" name="action" value="save">{reply?'保存回复':'发布回复'}</button></div>
    <p class="field-help">支持 Markdown、Unicode 表情、@用户名和本站图片。</p>
  </form>;
}
