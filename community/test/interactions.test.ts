import { describe, it, expect } from 'vitest';
import { fixture, browser } from './helpers.js';
import { renderMarkdown } from '../src/lib/markdown.js';

async function setup() {
  const f=await fixture();
  const insert=f.db.prepare("INSERT INTO users(id,username,username_key,password_hash,created_at,first_post_approved) SELECT ?,?,?,password_hash,created_at,1 FROM users WHERE id=1");
  for(let id=2;id<=8;id++) insert.run(id,`同学${id}`,`同学${id}`);
  f.db.prepare("INSERT INTO posts(id,author_id,category_id,title,body,html,excerpt,toc,tags_text,status,created_at,last_activity) VALUES (1,2,2,'一起学习工具调用','学习工具调用','<p>学习工具调用</p>','学习工具调用','[]','','public',?,?)").run(f.now,f.now);
  const a=browser(f.app),b=browser(f.app);await a.login('同学2');await a.request('/p/1');await b.login('同学3');await b.request('/p/1');
  return {...f,a,b};
}
describe('C3 楼层与互动',()=>{
  it('R-1 回复对象、原楼回复数与就地展开；本人可编辑删除，其他人无权修改',async()=>{
    const f=await setup();
    expect((await f.a.post('/p/1/reply',{body:'这是第一楼'})).status).toBe(303);
    const response=await f.b.post('/p/1/reply',{body:'回复第一楼',parentFloor:'1'});
    expect(response.headers.get('location')).toBe('/p/1?page=1#2');
    const detail=await (await f.b.request('/p/1')).text();
    expect(detail).toContain('回复 #1 @同学2');expect(detail).toContain('1 条回复');
    expect((await (await f.b.request('/p/1/children/1')).json()).html).toContain('回复第一楼');
    expect((await f.a.post('/replies/2/edit',{body:'篡改'})).status).toBe(403);
    expect((await f.b.post('/replies/2/edit',{body:'已修改回复'})).status).toBe(303);
    expect((await f.b.post('/replies/2/delete')).status).toBe(303);
    expect(await (await f.a.request('/p/1')).text()).not.toContain('已修改回复');
    expect((await f.b.post('/p/1/reply',{body:'错误对象',parentFloor:'500'})).status).toBe(422);
    await f.close();
  });
  it('R-3 200 楼初始仅30条，任意页可定位150楼且分页保留固定楼层',async()=>{
    const f=await setup();
    const insert=f.db.prepare('INSERT INTO replies(post_id,author_id,floor,body,html,created_at) VALUES (1,3,?,?,?,?)');
    f.db.transaction(()=>{for(let n=1;n<=200;n++)insert.run(n,`正文${n}`,`<p>正文${n}</p>`,f.now+n);})();
    const html=await (await f.a.request('/p/1')).text();
    expect((html.match(/data-reply-id=/g)??[]).length).toBe(30);expect(html).not.toContain('正文31');
    const page=await (await f.a.request('/p/1/replies?from=121')).json();
    expect(page.html).toContain('id="150"');expect(page.maxFloor).toBe(200);expect(page.nextFrom).toBe(151);
    expect((await (await f.a.request('/p/1/replies?from=181')).json()).nextFrom).toBeNull();
    await f.close();
  });
  it('R-4 点赞和取消立即返回计数，重复请求幂等，拒绝自己点赞',async()=>{
    const f=await setup();
    for(let n=0;n<3;n++)expect(await (await f.b.post('/p/1/vote',{active:'1'},true)).json()).toEqual({active:true,count:1});
    expect(await (await f.b.post('/p/1/vote',{active:'0'},true)).json()).toEqual({active:false,count:0});
    expect((await f.a.post('/p/1/vote',{active:'1'})).status).toBe(422);
    await f.close();
  });
  it('R-5 固定表情可多选、幂等和取消，非法表情拒绝；收藏仅自己可见',async()=>{
    const f=await setup();
    for(const emoji of ['👍','❤️','👍'])expect((await f.b.post('/reactions/post/1',{emoji,active:'1'},true)).status).toBe(200);
    expect(f.db.prepare('SELECT COUNT(*) n FROM reactions').get()).toEqual({n:2});
    await f.b.post('/reactions/post/1',{emoji:'👍',active:'0'});
    expect((await f.b.post('/reactions/post/1',{emoji:'💰',active:'1'})).status).toBe(422);
    await f.b.post('/p/1/bookmark',{active:'1'});
    expect(await (await f.b.request('/bookmarks')).text()).toContain('一起学习工具调用');
    expect(await (await f.a.request('/bookmarks')).text()).not.toContain('一起学习工具调用');
    await f.close();
  });
  it('R-6 已有用户名渲染链接，不存在的用户名保留文字',async()=>{
    const f=await setup();const html=renderMarkdown(f.db,'@同学2 @不存在的用户',f.config.siteUrl).html;
    expect(html).toContain('href="/u/2"');expect(html).toContain('@不存在的用户');expect(html.match(/<a /g)).toHaveLength(1);await f.close();
  });
  it('B-9 回复、楼层回复和提及正确通知；5人点赞按小时合并；不通知自己；阅读定位对应楼层',async()=>{
    const f=await setup();
    await f.b.post('/p/1/reply',{body:'@同学4 请来看看'});
    await f.a.post('/p/1/reply',{body:'回复你的意见',parentFloor:'1'});
    expect(f.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=2 AND kind='reply'").get()).toEqual({n:1});
    expect(f.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=3 AND kind='reply-to'").get()).toEqual({n:1});
    expect(f.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=4 AND kind='mention'").get()).toEqual({n:1});
    for(let id=3;id<=7;id++){const b=browser(f.app);await b.login(`同学${id}`);await b.request('/p/1');await b.post('/p/1/vote',{active:'1'});}
    expect(f.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=2 AND kind='like'").get()).toEqual({n:1});
    expect(await (await f.a.request('/notifications')).text()).toContain('等 5 人');
    expect(f.db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=actor_id').get()).toEqual({n:0});
    const row=f.db.prepare("SELECT id FROM notifications WHERE user_id=2 AND kind='reply'").get() as {id:number};
    expect((await f.a.post(`/notifications/${row.id}/read`)).headers.get('location')).toBe('/p/1?page=1#1');
    await f.a.post('/notifications/read-all');expect(await (await f.a.request('/notifications/count')).json()).toEqual({unread:0});
    await f.close();
  });
});
