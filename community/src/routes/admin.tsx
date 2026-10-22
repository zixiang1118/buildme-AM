import type { Hono } from 'hono';
import type { Env, User, Category } from '../types.js';
import { requireUser, requireAdmin, requireStaff } from '../lib/session.js';
import { FormError, textField, length, usernameKey } from '../lib/validation.js';
import { getPost, canWrite, postSelect, type Post } from '../lib/posts.js';
import { getReply, notify } from '../lib/interactions.js';
import { ensureNameAvailable, logAdmin, limit } from '../lib/auth.js';
import { firstPostReview, reportReasons } from '../lib/moderation.js';
import { AdminPosts, AdminUsers, AdminCatalog, AdminWords, AdminSettings, AdminStats, AdminLogs, ModerationQueue, type QueueItem, type ProfileRequest, type TagRequest, type CatalogItem, type BlockedWord } from '../views/admin.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
async function directoryBytes(path:string):Promise<number> {const entries=await readdir(path,{withFileTypes:true});return (await Promise.all(entries.map(async e=>e.isDirectory()?directoryBytes(join(path,e.name)):(await stat(join(path,e.name))).size))).reduce((a,b)=>a+b,0);}
const integer=(raw:string,min:number,max:number)=>{const n=Number(raw);if(!Number.isInteger(n)||n<min||n>max)throw new FormError(`请输入 ${min}–${max} 之间的整数`);return n;};
export function administration(app:Hono<Env>) {
  app.post('/reports/:kind/:id',async c=>{
    const user=requireUser(c),db=c.get('db'),kind=c.req.param('kind'),id=Number(c.req.param('id')),now=c.get('now');canWrite(user,now);
    if(kind!=='post'&&kind!=='reply')throw new FormError('内容不存在',{},404);
    const reply=kind==='reply'?getReply(db,id):null;const post=getPost(db,reply?.post_id??id,user);
    if(post.status!=='public')throw new FormError('内容不存在',{},404);
    const form=await c.req.formData(),reason=textField(form,'reason'),description=textField(form,'description');
    if(!reportReasons.includes(reason)||length(description)>1000)throw new FormError('请选择举报原因，说明最多1000字');
    limit(db,'report',String(user.id),20,86400000,now);
    db.transaction(()=>{
      db.prepare('INSERT OR IGNORE INTO reports(kind,target_id,reporter_id,reason,description,created_at) VALUES (?,?,?,?,?,?)').run(kind,id,user.id,reason,description,now);
      const count=(db.prepare('SELECT COUNT(*) n FROM reports WHERE kind=? AND target_id=?').get(kind,id) as {n:number}).n;
      if(count>=3)db.prepare(`UPDATE ${kind==='post'?'posts':'replies'} SET status='hidden' WHERE id=?`).run(id);
    })();
    return c.redirect('/latest?reported=1',303);
  });
  app.get('/admin/review',c=>{
    const user=requireStaff(c),db=c.get('db');
    const items=db.prepare(`SELECT 'post' kind,p.id,p.id postId,p.title,p.body,u.username,p.author_id authorId,p.status,(SELECT COUNT(*) FROM reports WHERE kind='post' AND target_id=p.id) reports FROM posts p JOIN users u ON u.id=p.author_id WHERE p.status IN ('pending','hidden') OR (p.status='public' AND EXISTS(SELECT 1 FROM reports WHERE kind='post' AND target_id=p.id)) UNION ALL SELECT 'reply',r.id,r.post_id,p.title,r.body,u.username,r.author_id,r.status,(SELECT COUNT(*) FROM reports WHERE kind='reply' AND target_id=r.id) FROM replies r JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=r.author_id WHERE r.deleted=0 AND (r.status IN ('pending','hidden') OR EXISTS(SELECT 1 FROM reports WHERE kind='reply' AND target_id=r.id)) LIMIT 200`).all() as QueueItem[];
    for(const item of items){const reports=db.prepare('SELECT reason,description FROM reports WHERE kind=? AND target_id=?').all(item.kind,item.id) as {reason:string;description:string}[];if(reports.length)item.body+='\n\n举报说明：\n'+reports.map(r=>r.reason+'：'+r.description).join('\n');}
    const profiles=user.role==='admin'?db.prepare('SELECT * FROM pending_profiles').all() as ProfileRequest[]:[];
    const tags=user.role==='admin'?db.prepare("SELECT r.*,u.username FROM tag_requests r JOIN users u ON u.id=r.user_id WHERE r.status='pending'").all() as TagRequest[]:[];
    return c.html(<ModerationQueue c={c} items={items} profiles={profiles} tags={tags}/>);
  });
  app.get('/admin/posts',c=>{
    const user=requireStaff(c),query=(c.req.query('q')??'').slice(0,100),db=c.get('db');
    const posts=db.prepare(`${postSelect} WHERE instr(p.title,@q)>0 OR instr(p.body,@q)>0 OR CAST(p.id AS TEXT)=@q ORDER BY p.id DESC LIMIT 100`).all({viewer:user.id,q:query}) as Post[];
    return c.html(<AdminPosts c={c} posts={posts} query={query} categories={db.prepare('SELECT * FROM categories ORDER BY position').all() as Category[]}/>);
  });
  app.post('/admin/content/:kind/:id/action',async c=>{
    const actor=requireStaff(c),db=c.get('db'),now=c.get('now'),kind=c.req.param('kind'),id=integer(c.req.param('id'),1,Number.MAX_SAFE_INTEGER),form=await c.req.formData(),action=textField(form,'action');
    if(kind!=='post'&&kind!=='reply')throw new FormError('内容不存在',{},404);
    const table=kind==='post'?'posts':'replies',row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as {author_id:number;category_id:number;status:string;post_id:number}|undefined;
    if(!row)throw new FormError('内容不存在',{},404);
    if(!['approve','restore','delete','feature','unfeature','pin','unpin','move'].includes(action)||(kind==='reply'&&!['approve','restore','delete'].includes(action)))throw new FormError('操作无效');
    if(textField(form,'banAuthor')==='1')requireAdmin(c);
    db.transaction(()=>{
      if(action==='approve'||action==='restore') {
        db.prepare(`UPDATE ${table} SET status='public'${kind==='reply'?',deleted=0':''} WHERE id=?`).run(id);
        db.prepare('DELETE FROM reports WHERE kind=? AND target_id=?').run(kind,id);
        if(kind==='post')db.prepare('UPDATE users SET first_post_approved=1 WHERE id=?').run(row.author_id);
      } else if(action==='delete')db.prepare(`UPDATE ${table} SET ${kind==='post'?"status='deleted'":"deleted=1"} WHERE id=?`).run(id);
      else if(action==='feature'||action==='unfeature')db.prepare('UPDATE posts SET featured=? WHERE id=?').run(action==='feature'?1:0,id);
      else if(action==='unpin')db.prepare('UPDATE posts SET pinned=0,pin_category_id=NULL WHERE id=?').run(id);
      else if(action==='pin') {
        const scope=textField(form,'scope');if(!['global','category'].includes(scope))throw new FormError('请选择置顶范围');
        const category=scope==='category'?row.category_id:null;
        const count=(db.prepare('SELECT COUNT(*) n FROM posts WHERE pinned=1 AND pin_category_id IS ? AND id<>? AND status=\'public\'').get(category,id) as {n:number}).n;
        if(count>=3)throw new FormError('此范围最多置顶3篇，请先取消已有置顶');
        db.prepare('UPDATE posts SET pinned=1,pin_category_id=? WHERE id=?').run(category,id);
      } else if(action==='move') {
        const category=integer(textField(form,'category'),1,Number.MAX_SAFE_INTEGER);
        if(!db.prepare('SELECT 1 FROM categories WHERE id=? AND active=1').get(category))throw new FormError('板块不存在');
        if(category===4||row.category_id===4)throw new FormError('作品转换需要填写或移除封面等资料，请使用帖子编辑入口');
        db.prepare('UPDATE posts SET category_id=? WHERE id=?').run(category,id);
      }
      if(textField(form,'banAuthor')==='1') {db.prepare('UPDATE users SET banned=1 WHERE id=?').run(row.author_id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.author_id);logAdmin(db,actor.id,'user.ban',String(row.author_id),now);}
      logAdmin(db,actor.id,`${kind}.${action}`,String(id),now);
      const label:Record<string,string>={approve:'审核已通过',restore:'已恢复公开',delete:'已移除',feature:'已设为精华',unfeature:'已取消精华',pin:'已置顶',unpin:'已取消置顶',move:'已移动板块'};
      notify(db,row.author_id,actor.id,'moderation',null,0,now,`你的${kind==='post'?'帖子':'回复'} #${id} ${label[action]}`,action==='delete'?'/notifications':`/p/${kind==='post'?id:row.post_id}`);
    })();
    return c.redirect('/admin/review',303);
  });
  app.get('/admin/users',c=>{
    requireAdmin(c);const query=(c.req.query('q')??'').slice(0,100),users=c.get('db').prepare('SELECT * FROM users WHERE instr(username,?)>0 OR CAST(id AS TEXT)=? ORDER BY id DESC LIMIT 100').all(query,query) as User[];
    return c.html(<AdminUsers c={c} users={users} query={query}/>);
  });
  app.post('/admin/users/:id/action',async c=>{
    const actor=requireAdmin(c),db=c.get('db'),id=integer(c.req.param('id'),1,Number.MAX_SAFE_INTEGER),form=await c.req.formData(),action=textField(form,'action');
    if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(id))throw new FormError('用户不存在',{},404);
    if(id===actor.id)throw new FormError('不能修改自己的管理权限或状态');
    db.transaction(()=>{
      if(action==='ban'||action==='unban') {db.prepare('UPDATE users SET banned=? WHERE id=?').run(action==='ban'?1:0,id);if(action==='ban')db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);}
      else if(action==='mute'||action==='unmute')db.prepare('UPDATE users SET muted_until=? WHERE id=?').run(action==='mute'?c.get('now')+integer(textField(form,'days'),1,365)*86400000:null,id);
      else if(action==='role') {const role=textField(form,'role');if(!['admin','moderator','member'].includes(role))throw new FormError('角色无效');db.prepare('UPDATE users SET role=? WHERE id=?').run(role,id);}
      else throw new FormError('操作无效');
      logAdmin(db,actor.id,`user.${action}`,String(id),c.get('now'));
    })();return c.redirect('/admin/users',303);
  });
  app.post('/admin/profiles/:id',async c=>{
    const actor=requireAdmin(c),db=c.get('db'),id=Number(c.req.param('id')),action=textField(await c.req.formData(),'action'),row=db.prepare('SELECT * FROM pending_profiles WHERE user_id=?').get(id) as ProfileRequest|undefined;
    if(!row)throw new FormError('申请不存在',{},404);
    if(!['approve','reject'].includes(action))throw new FormError('操作无效');
    db.transaction(()=>{
      if(action==='approve') {ensureNameAvailable(db,row.username,id);db.prepare('UPDATE users SET renamed_at=CASE WHEN username<>? THEN ? ELSE renamed_at END,username=?,username_key=?,bio=?,profile_pending=0 WHERE id=?').run(row.username,c.get('now'),row.username,usernameKey(row.username),row.bio,id);}
      db.prepare('DELETE FROM pending_profiles WHERE user_id=?').run(id);logAdmin(db,actor.id,`profile.${action}`,String(id),c.get('now'));
      notify(db,id,actor.id,'moderation',null,0,c.get('now'),action==='approve'?'资料审核通过':'资料未通过审核，请修改用户名或简介','/settings');
    })();return c.redirect('/admin/review',303);
  });
  app.get('/admin/catalog',c=>{requireAdmin(c);const kind=c.req.query('kind')??'categories';if(!['categories','tags','harnesses'].includes(kind))throw new FormError('页面不存在',{},404);return c.redirect(`/admin/catalog/${kind}`);});
  for(const kind of ['categories','tags','harnesses'] as const)app.get(`/admin/catalog/${kind}`,c=>{requireAdmin(c);return c.html(<AdminCatalog c={c} kind={kind} items={c.get('db').prepare(`SELECT * FROM ${kind} ORDER BY position,id`).all() as CatalogItem[]}/>);});
  app.post('/admin/catalog/:kind/save',async c=>{
    const actor=requireAdmin(c),kind=c.req.param('kind'),db=c.get('db'),form=await c.req.formData(),name=textField(form,'name').trim(),id=textField(form,'id');
    if(!['categories','tags','harnesses'].includes(kind))throw new FormError('页面不存在',{},404);
    if(length(name)<1||length(name)>24)throw new FormError('名称需为1–24字');
    const position=integer(textField(form,'position'),0,9999),active=integer(textField(form,'active'),0,1);
    const columns=['name','position','active'],values:(string|number)[]=[name,position,active];
    if(kind==='categories') {const slug=textField(form,'slug'),description=textField(form,'description'),color=textField(form,'color');if(!/^[a-z0-9-]{1,32}$/.test(slug)||length(description)>200||!['brand','blue','green','purple','gray'].includes(color))throw new FormError('请检查板块路径、介绍和标记颜色');columns.push('slug','description','color');values.push(slug,description,color);}
    if(db.prepare(`SELECT 1 FROM ${kind} WHERE name=? AND id<>?`).get(name,id||0))throw new FormError('名称已存在');
    if(kind==='categories'&&db.prepare('SELECT 1 FROM categories WHERE slug=? AND id<>?').get(textField(form,'slug'),id||0))throw new FormError('板块路径已存在');
    if(id) {const result=db.prepare(`UPDATE ${kind} SET ${columns.map(x=>`${x}=?`).join(',')} WHERE id=?`).run(...values,integer(id,1,Number.MAX_SAFE_INTEGER));if(!result.changes)throw new FormError('记录不存在',{},404);}
    else db.prepare(`INSERT INTO ${kind}(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...values);
    logAdmin(db,actor.id,`${kind}.save`,id||name,c.get('now'));return c.redirect(`/admin/catalog/${kind}`,303);
  });
  app.get('/admin/words',c=>{requireAdmin(c);return c.html(<AdminWords c={c} words={c.get('db').prepare('SELECT * FROM blocked_words ORDER BY id').all() as BlockedWord[]}/>);});
  app.post('/admin/words',async c=>{const actor=requireAdmin(c),form=await c.req.formData(),word=textField(form,'word').trim(),level=textField(form,'level');if(length(word)<1||length(word)>100||!['reject','review'].includes(level))throw new FormError('词语需为1–100字，并选择拦截等级');c.get('db').prepare('INSERT INTO blocked_words(word,level) VALUES (?,?) ON CONFLICT(word) DO UPDATE SET level=excluded.level').run(word,level);logAdmin(c.get('db'),actor.id,'word.save',word,c.get('now'));return c.redirect('/admin/words',303);});
  app.post('/admin/words/:id/delete',c=>{const actor=requireAdmin(c);c.get('db').prepare('DELETE FROM blocked_words WHERE id=?').run(c.req.param('id'));logAdmin(c.get('db'),actor.id,'word.delete',c.req.param('id'),c.get('now'));return c.redirect('/admin/words',303);});
  app.get('/admin/settings',c=>{requireAdmin(c);return c.html(<AdminSettings c={c} firstPostReview={firstPostReview(c.get('db'))}/>);});
  app.post('/admin/settings',async c=>{const actor=requireAdmin(c),value=textField(await c.req.formData(),'firstPostReview');if(!['0','1'].includes(value))throw new FormError('设置值无效');c.get('db').prepare("UPDATE site_settings SET value=? WHERE key='first_post_review'").run(value);logAdmin(c.get('db'),actor.id,'settings.review',value,c.get('now'));return c.redirect('/admin/settings',303);});
  app.get('/admin/invites',c=>{requireAdmin(c);return c.redirect('/admin');});
  app.get('/admin/stats',async c=>{
    requireAdmin(c);const db=c.get('db'),day=Math.floor((c.get('now')+8*3600000)/86400000)*86400000-8*3600000;
    const stats=db.prepare('SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM users WHERE last_seen_at>=@day) activeToday,(SELECT COUNT(*) FROM users WHERE last_seen_at>=@week) activeWeek,(SELECT COUNT(*) FROM posts WHERE created_at>=@day) postsToday,(SELECT COUNT(*) FROM replies WHERE created_at>=@day) repliesToday').get({day,week:c.get('now')-7*86400000}) as {users:number;activeToday:number;activeWeek:number;postsToday:number;repliesToday:number};
    return c.html(<AdminStats c={c} stats={{...stats,storageBytes:await directoryBytes(c.get('config').dataDir)}}/>);
  });
  app.get('/admin/logs',c=>{const actor=requireStaff(c),logs=c.get('db').prepare(`SELECT u.username,l.action,l.target,l.created_at FROM admin_logs l JOIN users u ON u.id=l.actor_id ${actor.role==='moderator'?"WHERE l.action LIKE 'post.%' OR l.action LIKE 'reply.%' OR l.action LIKE 'work.%'":''} ORDER BY l.id DESC LIMIT 200`).all() as {username:string;action:string;target:string;created_at:number}[];return c.html(<AdminLogs c={c} logs={logs}/>);});
}
