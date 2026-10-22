import type { Hono, Context } from 'hono';
import type { Env } from '../types.js';
import { Layout, Csrf, Empty } from '../views/layout.js';
import { pageProps, Errors } from '../views/forms.js';
import { Reactions, ReplyCard, ReplyForm } from '../views/interactions.js';
import { PostCard } from '../views/posts.js';
import { requireUser } from '../lib/session.js';
import { FormError, length, textField } from '../lib/validation.js';
import { getPost, canWrite, newAccount } from '../lib/posts.js';
import { limit } from '../lib/auth.js';
import { saveImage } from '../lib/images.js';
import { renderMarkdown, referenceImages } from '../lib/markdown.js';
import { emojis, getReply, maxFloor, notify, notifyMentions, replyRows, unreadCount, type Reply } from '../lib/interactions.js';

import { moderationStatus, rejectDuplicate } from "../lib/moderation.js";
const json = (c:Context<Env>)=>c.req.header('accept')?.includes('application/json');
function activeValue(form:FormData) {
  const active=textField(form,'active');
  if(!['0','1'].includes(active)) throw new FormError('操作无效');
  return active==='1';
}
export function interactions(app:Hono<Env>) {
  app.get('/p/:id/replies',async c=>{
    const post=getPost(c.get('db'),Number(c.req.param('id')),c.get('user'));
    const from=Number(c.req.query('from') ?? 1);
    if(!Number.isInteger(from)||from<1) throw new FormError('楼层无效');
    const max=maxFloor(c.get('db'),post.id);
    const html=await <>{replyRows(c.get('db'),post.id,from).map(reply=><ReplyCard c={c} post={post} reply={reply}/>)}</>;
    return c.json({html:html.toString(),nextFrom:from+30<=max?from+30:null,maxFloor:max,total:post.reply_count});
  });
  app.get('/p/:id/children/:floor',async c=>{
    const post=getPost(c.get('db'),Number(c.req.param('id')),c.get('user'));
    const rows=replyRows(c.get('db'),post.id,1,Number(c.req.param('floor')));
    return c.json({html:(await <>{rows.map(reply=><ReplyCard c={c} post={post} reply={reply} inline/>)}</>).toString()});
  });
  app.get('/api/users',c=>{
    requireUser(c);
    const q=(c.req.query('q')??'').slice(0,16),post=Number(c.req.query('post')??0);
    const users=c.get('db').prepare(`SELECT u.id,u.username FROM users u WHERE u.banned=0 AND u.profile_pending=0 AND instr(u.username_key,lower(?))>0
      ORDER BY EXISTS(SELECT 1 FROM replies r WHERE r.post_id=? AND r.author_id=u.id) DESC,EXISTS(SELECT 1 FROM posts p WHERE p.id=? AND p.author_id=u.id) DESC,u.username LIMIT 6`).all(q,post,post);
    return c.json({users});
  });
  const compose = async (c:Context<Env>,old?:Reply)=>{
    const user=requireUser(c),db=c.get('db'),now=c.get('now');
    const post=getPost(db,old?.post_id??Number(c.req.param('id')),user);
    const form=await c.req.formData();
    let body=textField(form,'body').replace(/\r\n?/g,'\n');
    const parentFloor=textField(form,'parentFloor');
    const show=(error?:FormError,preview?:string)=>c.html(<Layout {...pageProps(c,old?'编辑回复':'撰写回复')}><a href={`/p/${post.id}`}>{post.title}</a><Errors error={error}/>{preview && <div class="panel prose" dangerouslySetInnerHTML={{__html:preview}}/>}<ReplyForm c={c} post={post} body={body} parentFloor={parentFloor} reply={old}/></Layout>,error?.status??200);
    try {
      canWrite(user,now);
      if(old && old.author_id!==user.id) throw new FormError('不能编辑他人的回复',{},403);
      if(textField(form,'action')==='upload') {
        limit(db,'image-hour',String(user.id),60,3600000,now);limit(db,'image-day',String(user.id),200,86400000,now);
        const file=form.get('image'); if(!(file instanceof File)) throw new FormError('请选择图片');
        const image=await saveImage(db,c.get('storage'),user.id,Buffer.from(await file.arrayBuffer()),now);
        body+=`\n\n![图片](${image.url})\n`;
        return show();
      }
      if(!body.trim()||length(body)>10000) throw new FormError('回复需为 1–10,000 字');
      const rendered=renderMarkdown(db,body,c.get('config').siteUrl);
      if(textField(form,'action')==='preview') return show(undefined,rendered.html);
      if(newAccount(db,user,now) && (rendered.imageCount>2 || (body.replace(/!\[[^\]]*\]\([^)]+\)/g,'').match(/https?:\/\/[^\s)]+/g)??[]).length>2)) throw new FormError('新账号每条内容最多 2 个外部链接、2 张图片');
      if(rendered.imageCount>30) throw new FormError('每条回复最多 30 张图片');
      const parent=parentFloor?db.prepare("SELECT r.* FROM replies r JOIN users u ON u.id=r.author_id WHERE r.post_id=? AND r.floor=? AND r.deleted=0 AND r.status='public' AND u.banned=0 AND u.profile_pending=0").get(post.id,parentFloor) as Reply|undefined:undefined;
      if(parentFloor && !parent) throw new FormError('回复对象不存在');
      const status=moderationStatus(db,user,body,now,c.get('config').siteUrl);
      if(!old) rejectDuplicate(db,user.id,body,now);
      if(!old) limit(db,'reply',String(user.id),newAccount(db,user,now)?3:6,60000,now);
      const floor=db.transaction(()=>{
        const floor=old?.floor??maxFloor(db,post.id)+1;
        let id=old?.id;
        if(old) db.prepare('UPDATE replies SET body=?,html=?,updated_at=? WHERE id=?').run(body,rendered.html,now,old.id);
        else id=Number(db.prepare('INSERT INTO replies(post_id,author_id,floor,body,html,created_at,parent_floor) VALUES (?,?,?,?,?,?,?)').run(post.id,user.id,floor,body,rendered.html,now,parent?.floor??null).lastInsertRowid);
        db.prepare('UPDATE replies SET status=? WHERE id=?').run(status,id!);
        referenceImages(db,'reply',id!,rendered.imageIds);
        if(!old && status==='public') {
          db.prepare('UPDATE posts SET last_activity=? WHERE id=?').run(now,post.id);
          notify(db,post.author_id,user.id,'reply',post.id,floor,now);
          if(parent && parent.author_id!==post.author_id) notify(db,parent.author_id,user.id,'reply-to',post.id,floor,now);
          notifyMentions(db,body,user.id,post.id,floor,now,[post.author_id,...(parent?[parent.author_id]:[])]);
        }
        return floor;
      })();
      return c.redirect(`/p/${post.id}?page=${Math.ceil(floor/30)}#${floor}`,303);
    } catch(error) {if(!(error instanceof FormError)) throw error;return show(error);}
  };
  app.post('/p/:id/reply',c=>compose(c));
  app.get('/replies/:id/edit',c=>{
    const user=requireUser(c),reply=getReply(c.get('db'),Number(c.req.param('id'))),post=getPost(c.get('db'),reply.post_id,user);
    if(reply.author_id!==user.id) throw new FormError('不能编辑他人的回复',{},403);
    return c.html(<Layout {...pageProps(c,'编辑回复')}><h1>编辑 #{reply.floor}</h1><ReplyForm c={c} post={post} body={reply.body} parentFloor={String(reply.parent_floor??'')} reply={reply}/></Layout>);
  });
  app.post('/replies/:id/edit',c=>compose(c,getReply(c.get('db'),Number(c.req.param('id')))));
  app.post('/replies/:id/delete',c=>{
    const user=requireUser(c),reply=getReply(c.get('db'),Number(c.req.param('id')));
    getPost(c.get('db'),reply.post_id,user);
    if(reply.author_id!==user.id) throw new FormError('不能删除他人的回复',{},403);
    c.get('db').prepare('UPDATE replies SET deleted=1 WHERE id=?').run(reply.id);
    return c.redirect(`/p/${reply.post_id}`,303);
  });
  app.post('/p/:id/vote',async c=>{
    const user=requireUser(c),db=c.get('db'),post=getPost(db,Number(c.req.param('id')),user);
    if(post.author_id===user.id) throw new FormError('不能给自己的帖子点赞');
    limit(db,'reaction',String(user.id),60,60000,c.get('now'));
    const active=activeValue(await c.req.formData());
    db.transaction(()=>{
      if(active) {const result=db.prepare('INSERT OR IGNORE INTO votes VALUES (?,?,?)').run(post.id,user.id,c.get('now'));if(result.changes) notify(db,post.author_id,user.id,'like',post.id,0,c.get('now'));}
      else db.prepare('DELETE FROM votes WHERE post_id=? AND user_id=?').run(post.id,user.id);
    })();
    const count=(db.prepare('SELECT COUNT(*) n FROM votes WHERE post_id=?').get(post.id) as {n:number}).n;
    return json(c)?c.json({active,count}):c.redirect(`/p/${post.id}`,303);
  });
  app.post('/reactions/:kind/:id',async c=>{
    const user=requireUser(c),db=c.get('db'),kind=c.req.param('kind'),id=Number(c.req.param('id'));
    if(kind!=='post'&&kind!=='reply') throw new FormError('回应对象无效');
    const reply=kind==='reply'?getReply(db,id):undefined;
    const post=getPost(db,reply?.post_id??id,user),form=await c.req.formData(),emoji=textField(form,'emoji'),active=activeValue(form);
    if(!emojis.includes(emoji)) throw new FormError('请选择支持的表情');
    limit(db,'reaction',String(user.id),60,60000,c.get('now'));
    db.transaction(()=>{
      if(active) {const result=db.prepare('INSERT OR IGNORE INTO reactions VALUES (?,?,?,?,?)').run(kind,id,user.id,emoji,c.get('now'));if(result.changes) notify(db,reply?.author_id??post.author_id,user.id,'like',post.id,reply?.floor??0,c.get('now'));}
      else db.prepare('DELETE FROM reactions WHERE kind=? AND target_id=? AND user_id=? AND emoji=?').run(kind,id,user.id,emoji);
    })();
    return json(c)?c.json({html:(await <Reactions c={c} kind={kind} id={id}/>).toString()}):c.redirect(`/p/${post.id}${reply?`?page=${Math.ceil(reply.floor/30)}#${reply.floor}`:''}`,303);
  });
  app.post('/p/:id/bookmark',async c=>{
    const user=requireUser(c),db=c.get('db'),post=getPost(db,Number(c.req.param('id')),user),active=activeValue(await c.req.formData());
    limit(db,'reaction',String(user.id),60,60000,c.get('now'));
    if(active) db.prepare('INSERT OR IGNORE INTO bookmarks VALUES (?,?,?)').run(user.id,post.id,c.get('now'));
    else db.prepare('DELETE FROM bookmarks WHERE user_id=? AND post_id=?').run(user.id,post.id);
    return json(c)?c.json({active,count:active?1:0}):c.redirect(`/p/${post.id}`,303);
  });
  app.get('/bookmarks',c=>{
    const user=requireUser(c),db=c.get('db');
    const ids=db.prepare("SELECT b.post_id FROM bookmarks b JOIN posts p ON p.id=b.post_id JOIN users u ON u.id=p.author_id WHERE b.user_id=? AND p.status='public' AND u.banned=0 AND u.profile_pending=0 ORDER BY b.created_at DESC").all(user.id) as {post_id:number}[];
    return c.html(<Layout {...pageProps(c,'我的收藏')}><h1>我的收藏</h1><p class="muted">只有你可以看到。</p><div class="feed">{ids.length?ids.map(x=><PostCard c={c} post={getPost(db,x.post_id,user)}/>):<Empty title="还没有收藏"/>}</div></Layout>);
  });
  app.get('/notifications/count',c=>c.json({unread:unreadCount(c.get('db'),requireUser(c))}));
  app.get('/notifications',c=>{
    const user=requireUser(c),db=c.get('db');
    const rows=db.prepare("SELECT n.*,COALESCE(p.title,n.message) title,n.message,u.username,(SELECT COUNT(*) FROM notification_actors a WHERE a.notification_id=n.id) actors FROM notifications n LEFT JOIN posts p ON p.id=n.post_id LEFT JOIN users author ON author.id=p.author_id JOIN users u ON u.id=n.actor_id WHERE n.user_id=? AND (n.post_id IS NULL OR (p.status='public' AND author.banned=0 AND author.profile_pending=0)) ORDER BY n.updated_at DESC,n.id DESC LIMIT 200").all(user.id) as {id:number;kind:string;title:string;message:string;username:string;actors:number;read_at:number|null}[];
    const labels:Record<string,string>={reply:'回复了你的帖子','reply-to':'回复了你的回复',mention:'提到了你',like:'赞了你的内容',featured:'将你的帖子设为精华',selected:'将你的作品设为精选',moderation:'处理了你的内容'};
    return c.html(<Layout {...pageProps(c,'通知')}><div class="page-heading"><h1>通知</h1><form method="post" action="/notifications/read-all"><Csrf value={c.get('csrf')}/><button class="button">全部标为已读</button></form></div><div class="notification-list">{rows.length?rows.map(n=><form class={`panel notification ${n.read_at?'':'unread'}`} method="post" action={`/notifications/${n.id}/read`}><Csrf value={c.get('csrf')}/><button class="notification-link">{n.message || `${n.username}${n.actors>1?`等 ${n.actors} 人`:''}${labels[n.kind]}《${n.title}》`}{!n.read_at&&<span class="tag">未读</span>}</button></form>):<Empty title="暂时没有通知"/>}</div></Layout>);
  });
  app.post('/notifications/read-all',c=>{const user=requireUser(c);c.get('db').prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(c.get('now'),user.id);return c.redirect('/notifications',303);});
  app.post('/notifications/:id/read',c=>{
    const user=requireUser(c),db=c.get('db'),row=db.prepare('SELECT post_id,floor,link FROM notifications WHERE id=? AND user_id=?').get(c.req.param('id'),user.id) as {post_id:number|null;floor:number;link:string}|undefined;
    if(!row) throw new FormError('通知不存在',{},404);
    db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(c.get('now'),c.req.param('id'),user.id);
    if(row.post_id===null)return c.redirect(row.link||'/settings',303);
    return c.redirect(`/p/${row.post_id}${row.floor?`?page=${Math.ceil(row.floor/30)}#${row.floor}`:''}`,303);
  });
}
