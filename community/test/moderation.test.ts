import { expect, it } from 'vitest';
import { fixture,browser } from './helpers.js';
import { limit, privateKey } from '../src/lib/auth.js';
import { rejectDuplicate, moderationStatus } from '../src/lib/moderation.js';
import type { User } from '../src/types.js';
import { migrate } from '../src/db/index.js';
import { notify,unreadCount } from '../src/lib/interactions.js';
async function setup() {const f=await fixture(),admin=browser(f.app);await admin.login();await admin.request('/admin');const member=browser(f.app);await member.request('/register');await member.post('/register',{username:'测试成员',password:'member-password',invite:f.invite()});await member.request('/settings');return {f,admin,member};}
it('M-1 M-4 首帖审核开关、通过后公开，数字标点重复被拒绝',async()=>{
 const {f,admin,member}=await setup();expect((await member.post('/new',{title:'首条内容测试',body:'内容123',category:'1'})).status).toBe(303);
 expect((await f.app.request('/p/1')).status).toBe(404);expect(await (await member.request('/p/1')).text()).toContain('审核中');
 expect((await admin.post('/admin/content/post/1/action',{action:'approve'})).status).toBe(303);expect((await f.app.request('/p/1')).status).toBe(200);
 f.setNow(f.now+61000);expect((await member.post('/new',{title:'首条内容测试!',body:'内容456?',category:'1'})).status).toBe(422);
 expect((await member.post('/new',{title:'另一条正常内容',body:'新的文字',category:'1'})).status).toBe(303);expect(f.db.prepare('SELECT status FROM posts WHERE id=2').get()).toEqual({status:'public'});
 expect((await admin.post('/admin/settings',{firstPostReview:'0'})).status).toBe(303);await f.close();
});
it('M-2 M-6 新账号链接限制、第四次同域待审与屏蔽词覆盖资料正文回复和链接标题',async()=>{
 const {f,admin,member}=await setup();
 expect((await member.post('/new',{title:'太多链接测试',category:'1',body:'https://a.com https://b.com https://c.com'})).status).toBe(422);
 await admin.post('/admin/words',{word:'拒绝词',level:'reject'});await admin.post('/admin/words',{word:'审核词',level:'review'});
 for(const values of [{title:'拒绝词的标题',body:''},{title:'正常标题内容',body:'拒绝词'}])expect((await member.post('/new',{...values,category:'1'})).status).toBe(422);
 expect((await member.post('/settings',{username:'拒绝词用户',bio:''})).status).toBe(422);
 expect((await member.post('/settings',{username:'测试成员',bio:'审核词'})).status).toBe(200);expect(f.db.prepare('SELECT bio FROM users WHERE id=2').get()).toEqual({bio:''});
 expect((await admin.post('/admin/profiles/2',{action:'approve'})).status).toBe(303);expect(unreadCount(f.db,{id:2})).toBe(1);
 expect((await member.post('/new',{title:'审核词的内容',body:'文字',category:'1'})).status).toBe(303);await admin.post('/admin/content/post/1/action',{action:'approve'});
 expect((await member.post('/p/1/reply',{body:'拒绝词'})).status).toBe(422);expect((await member.post('/p/1/reply',{body:'审核词'})).status).toBe(303);expect(f.db.prepare('SELECT status FROM replies').get()).toEqual({status:'pending'});
 f.db.prepare("INSERT INTO link_cache(url,title,source,thumbnail,expires_at) VALUES ('https://metadata.example/','拒绝词','example','',?)").run(f.now+86400000);f.setNow(f.now+61000);
 expect((await member.post('/new',{title:'链接元数据检查',body:'',category:'1',link:'https://metadata.example'})).status).toBe(422);
 for(let i=0;i<3;i++)f.db.prepare("INSERT INTO replies(post_id,author_id,floor,body,html,created_at) VALUES(1,2,?,'https://repeat.example/a','','1')").run(i+2);
 f.db.prepare('UPDATE replies SET created_at=?').run(f.now);
 const user=f.db.prepare('SELECT * FROM users WHERE id=2').get() as User;expect(moderationStatus(f.db,user,'https://repeat.example/b',f.now,f.config.siteUrl)).toBe('pending');
 f.db.prepare('UPDATE replies SET created_at=? WHERE floor=4').run(f.now+1);expect(()=>rejectDuplicate(f.db,2,'https://repeat.example/a',f.now+2)).toThrow();await f.close();
});
it('M-5 三个不同举报立即隐藏所有入口，恢复清零；回复也可举报',async()=>{
 const {f,admin,member}=await setup();await member.post('/new',{title:'需要举报的内容',body:'举报关键词',category:'1'});await admin.post('/admin/content/post/1/action',{action:'approve'});
 const reporters=[admin,member];const third=browser(f.app);await third.request('/register');await third.post('/register',{username:'第三位成员',password:'member-password',invite:f.invite()});await third.request('/settings');reporters.push(third);
 for(const b of reporters){expect((await b.post('/reports/post/1',{reason:'广告',description:'测试说明'})).status).toBe(303);if(b===admin)await b.post('/reports/post/1',{reason:'广告'});}
 for(const b of [member,third])expect((await b.request('/p/1')).status).toBe(404);
 for(const url of ['/latest','/','/search?q=举报关键词','/feed.xml'])expect(await (await f.app.request(url)).text()).not.toContain('需要举报的内容');
 await admin.post('/admin/content/post/1/action',{action:'restore'});expect((await f.app.request('/p/1')).status).toBe(200);expect(f.db.prepare('SELECT COUNT(*) n FROM reports').get()).toEqual({n:0});
 await member.post('/p/1/reply',{body:'被举报的回复'});for(const b of reporters)await b.post('/reports/reply/1',{reason:'其他'});expect(await (await f.app.request('/p/1')).text()).not.toContain('被举报的回复');await f.close();
});
it('M-7 M-9 M-10 权限矩阵、全部写接口CSRF与管理日志',async()=>{
 const {f,admin,member}=await setup();
 const restricted=['/admin','/admin/users','/admin/invites','/admin/settings','/admin/words','/admin/catalog/tags','/admin/stats','/admin/review','/admin/posts','/admin/logs','/admin/works'];
 for(const url of restricted)expect((await member.request(url)).status,url).toBe(404);
 await admin.post('/admin/users/2/action',{action:'role',role:'moderator'});
 for(const url of restricted.filter(x=>!['/admin','/admin/review','/admin/posts','/admin/logs','/admin/works'].includes(x)))expect((await member.request(url)).status,url).toBe(404);
 for(const url of ['/admin/review','/admin/posts','/admin/logs','/admin/works'])expect((await member.request(url)).status,url).toBe(200);
 for(const path of ['/new','/p/1/reply','/reports/post/1','/admin/users/2/action','/admin/content/post/1/action','/admin/words','/admin/words/1/delete','/admin/settings','/admin/profiles/2','/admin/catalog/tags/save','/admin/invites','/admin/reset-password'])expect((await admin.request(path,{method:'POST',body:new URLSearchParams({csrf:'wrong'})})).status,path).toBe(403);
 await admin.post('/admin/catalog/tags/save',{name:'新工具',position:'9',active:'1'});await admin.post('/admin/words',{word:'测试词',level:'review'});await admin.post('/admin/settings',{firstPostReview:'0'});
 const actions=f.db.prepare('SELECT action FROM admin_logs').all() as {action:string}[];expect(actions.map(x=>x.action)).toEqual(expect.arrayContaining(['user.role','tags.save','word.save','settings.review']));await f.close();
});
it('M-8 封禁撤销所有会话、所有内容隐藏；禁言保持浏览并阻止发言',async()=>{
 const {f,admin,member}=await setup();await member.post('/new',{title:'封禁前的帖子',body:'隐藏检索内容',category:'1'});await admin.post('/admin/content/post/1/action',{action:'approve'});
 await admin.post('/admin/users/2/action',{action:'mute',days:'7'});expect((await member.request('/p/1')).status).toBe(200);const denied=await member.post('/p/1/reply',{body:'禁言发言'});expect(denied.status).toBe(403);expect(await denied.text()).toContain('禁言至');
 await admin.post('/admin/users/2/action',{action:'ban'});expect(f.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=2').get()).toEqual({n:0});
 expect((await member.request('/settings')).status).toBe(403);expect(await (await member.login('测试成员','member-password')).text()).toContain('账号已被停用');
 for(const url of ['/latest','/search?q=隐藏检索','/feed.xml','/works'])expect(await (await f.app.request(url)).text()).not.toContain('封禁前的帖子');expect((await f.app.request('/p/1')).status).toBe(404);await f.close();
});
it('M-3 每个限流窗口上限返回429和恢复时间，超时可继续',async()=>{
 const {f,admin}=await setup();
 for(const [scope,max,window] of [['register',5,3600000],['post',10,3600000],['reply',6,60000],['image-hour',60,3600000],['image-day',200,86400000],['reaction',60,60000],['search',30,60000],['report',20,86400000]] as const){for(let i=0;i<max;i++)limit(f.db,scope,'boundary',max,window,f.now);try{limit(f.db,scope,'boundary',max,window,f.now);throw Error('expected limit');}catch(e){expect(e).toMatchObject({status:429});expect((e as Error).message).toContain('秒后再试');}expect(()=>limit(f.db,scope,'boundary',max,window,f.now+window+1)).not.toThrow();}
 for(let i=0;i<30;i++)limit(f.db,'search',privateKey('127.0.0.1',f.config.sessionSecret),30,60000,f.now);expect((await admin.request('/search?q=测试')).status).toBe(429);f.setNow(f.now+60001);expect((await admin.request('/search?q=测试')).status).toBe(200);await f.close();
});
it('D-3 C6重复迁移保留通知、参与者及审核数据',async()=>{const {f}=await setup();notify(f.db,2,1,'moderation',null,0,f.now,'资料通过','/settings');migrate(f.db);migrate(f.db);expect(f.db.prepare('SELECT message FROM notifications').get()).toEqual({message:'资料通过'});expect(f.db.prepare('SELECT COUNT(*) n FROM notification_actors').get()).toEqual({n:1});await f.close();});
