import { it, expect } from 'vitest';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, browser } from './helpers.js';
import { blankWork, writeWork, getWork, worksPage, homeWorks, selectedWorks } from '../src/lib/works.js';
import { search, feed } from '../src/lib/browse.js';
async function setup() {
  const f=await fixture(),b=browser(f.app);await b.login();await b.request('/new?category=4');
  const image=await (await b.post('/works/cover',{cover:new Blob([new Uint8Array(await sharp({create:{width:900,height:1400,channels:3,background:'#c4582f'}}).png().toBuffer())],{type:'image/png'})},true)).json() as {id:string;url:string};
  const create=(title:string,age=0,harness='1')=>{
    const id=Number(f.db.prepare("INSERT INTO posts(author_id,category_id,title,body,html,excerpt,toc,tags_text,status,created_at,last_activity) VALUES (1,4,?,'作品介绍','<p>作品介绍</p>','作品介绍','[]','','public',?,?)").run(title,f.now-age,f.now-age).lastInsertRowid);
    writeWork(f.db,id,{...blankWork(),summary:'日历订阅自动整理',coverId:image.id,harnesses:[harness]},image.id);return id;
  };
  return {f,b,image,create};
}
it('W-1 作品标题、介绍、封面、制作工具和地址校验，输入保留',async()=>{
  const {f,b,image}=await setup();
  const input={title:'我的第一个作品',category:'4',body:'详细介绍',summary:'整理课程表',coverId:image.id,harnesses:'1'};
  const invalid:Record<string,string>[]=[{summary:''},{coverId:''},{harnesses:''},{title:'名'.repeat(41)},{demoUrl:'javascript:alert(1)'}];
  for(const patch of invalid) {
    const response=await b.post('/new',{...input,...patch});expect(response.status).toBe(422);expect(await response.text()).toContain(patch.title ?? input.title);
  }
  expect(f.db.prepare('SELECT COUNT(*) n FROM works').get()).toEqual({n:0});await f.close();
});
it('W-2 任意比例上传经位置和缩放裁剪后存为16:10，缩略图不变形',async()=>{
  const {f,b,image}=await setup();
  const response=await b.post('/new',{title:'真正裁剪的作品封面',category:'4',body:'制作过程',summary:'一张纵图裁剪成封面',coverId:image.id,harnesses:'3',cropX:'35',cropY:'80',cropZoom:'1.5'});
  expect(response.status).toBe(303);
  const work=getWork(f.db,1,null)!;
  const metadata=await sharp(await readFile(join(f.config.dataDir,work.cover_url))).metadata();
  expect(metadata.width).toBe(1600);expect(metadata.height).toBe(1000);
  const thumb=await sharp(await readFile(join(f.config.dataDir,work.cover_thumb))).metadata();expect(thumb.width).toBe(640);expect(thumb.height).toBe(400);
  expect(f.db.prepare("SELECT image_id FROM image_refs WHERE kind='post' AND entity_id=1").get()).toEqual({image_id:work.cover_id});await f.close();
});
it('W-3 作品墙和作品板块共享点赞回复计数，简介进入全文索引',async()=>{
  const {f,create}=await setup(),id=create('共享互动数据的作品');
  f.db.prepare('INSERT INTO votes VALUES (?,1,?)').run(id,f.now);f.db.prepare("INSERT INTO replies(post_id,author_id,floor,body,html,created_at) VALUES (?,1,1,'测试回复','<p>测试回复</p>',?)").run(id,f.now);
  const wall=worksPage(f.db,null,{sort:'votes',range:'all',harness:''},f.now).works[0].post;
  const list=feed(f.db,null,'category',{sort:'active',range:'all',category:'4',tag:''},f.now,'/c/work').posts[0];
  expect([wall.vote_count,wall.reply_count]).toEqual([1,1]);expect([list.vote_count,list.reply_count]).toEqual([1,1]);
  expect(search(f.db,{q:'日历订阅',type:'posts',category:'',tag:'',author:'',range:'all',sort:'relevance',page:1},f.now).items.map(x=>x.id)).toEqual([id]);await f.close();
});
it('W-4 最受欢迎、最新、周月时间范围和制作工具筛选正确',async()=>{
  const {f,create}=await setup(),old=create('上个月的作品',40*86400000),week=create('这周做出的作品',86400000,'3'),month=create('本月发布的作品',20*86400000);
  f.db.prepare('INSERT INTO votes VALUES (?,1,?)').run(month,f.now);
  const wall=(sort='votes',range='all',harness='')=>worksPage(f.db,null,{sort,range,harness},f.now).works.map(x=>x.post.id);
  expect(wall()).toEqual([month,week,old]);expect(wall('latest')).toEqual([week,month,old]);expect(wall('votes','week')).toEqual([week]);expect(wall('votes','month')).toEqual([month,week]);expect(wall('votes','all','3')).toEqual([week]);await f.close();
});
it('W-5 管理员设精选只展示最近设置4件，取消生效且记录日志',async()=>{
  const {f,b,create}=await setup();const ids=Array.from({length:5},(_,i)=>create(`作品精选序号${i}`));
  for(const id of ids){f.setNow(f.now+1000);expect((await b.post(`/admin/works/${id}/select`,{active:'1'})).status).toBe(303);}
  expect(selectedWorks(f.db,null,4).map(x=>x.post.id)).toEqual([...ids].reverse().slice(0,4));
  await b.post(`/admin/works/${ids[4]}/select`,{active:'0'});expect(selectedWorks(f.db,null,4).map(x=>x.post.id)).not.toContain(ids[4]);
  expect(f.db.prepare("SELECT COUNT(*) n FROM admin_logs WHERE action LIKE 'work.%'").get()).toEqual({n:6});await f.close();
});
it('W-6 首页选14天内获赞最多4件，不足用旧作品按最新补齐，空态明确',async()=>{
  const {f,create}=await setup();expect(homeWorks(f.db,null,f.now)).toEqual([]);expect(await (await f.app.request('/')).text()).toContain('还没有作品，来发第一个');
  const a=create('过去较早的作品',30*86400000),b=create('过去较新的作品',20*86400000),c=create('近期先发布作品',2*86400000),d=create('近期刚发布作品');
  f.db.prepare('INSERT INTO votes VALUES (?,1,?)').run(c,f.now);
  expect(homeWorks(f.db,null,f.now).map(x=>x.post.id)).toEqual([c,d,b,a]);await f.close();
});
