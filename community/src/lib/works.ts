import sharp from 'sharp';
import type { Db } from '../db/index.js';
import type { User } from '../types.js';
import type { Storage } from './storage.js';
import { getPost, type Post } from './posts.js';
import { feed, since } from './browse.js';
import { FormError, httpUrl, length, textField } from './validation.js';
import { saveImage } from './images.js';

export interface WorkInput {summary:string;coverId:string;demoUrl:string;sourceUrl:string;harnesses:string[];otherHarness:string;cropX:string;cropY:string;cropZoom:string}
export interface Harness {id:number;name:string;position:number;active:number}
export interface Work {post:Post;summary:string;cover_id:string;cover_url:string;cover_thumb:string;demo_url:string;source_url:string;other_harness:string;selected_at:number|null;harnesses:{id:number;name:string}[]}
export interface WorkPageData {works:Work[];selected:Work[];harnesses:Harness[];sort:string;range:string;harness:string;next:string|null}
export function blankWork():WorkInput {return {summary:'',coverId:'',demoUrl:'',sourceUrl:'',harnesses:[],otherHarness:'',cropX:'50',cropY:'50',cropZoom:'1'};}
export function workInput(form:FormData):WorkInput {return {summary:textField(form,'summary').trim(),coverId:textField(form,'coverId'),demoUrl:textField(form,'demoUrl').trim(),sourceUrl:textField(form,'sourceUrl').trim(),harnesses:form.getAll('harnesses').filter((x):x is string=>typeof x==='string'),otherHarness:textField(form,'otherHarness').trim(),cropX:textField(form,'cropX')||'50',cropY:textField(form,'cropY')||'50',cropZoom:textField(form,'cropZoom')||'1'};}
export function harnesses(db:Db) {return db.prepare('SELECT * FROM harnesses WHERE active=1 ORDER BY position,id').all() as Harness[];}
export function validateWork(db:Db,title:string,input:WorkInput,draft=false) {
  const fields:Record<string,string>={};
  if(!draft && (length(title)<4||length(title)>40))fields.title='作品名需为 4–40 字';
  if((!draft&&!input.summary)||length(input.summary)>60)fields.summary='请填写最多60字的一句话介绍';
  if(!draft && !input.coverId)fields.coverId='请上传作品封面';
  const all=harnesses(db),chosen=input.harnesses;
  if((!draft&&!chosen.length)||chosen.some(id=>!all.some(h=>String(h.id)===id))||new Set(chosen).size!==chosen.length)fields.harnesses='请至少选择一项有效的制作工具';
  const other=all.find(h=>h.name==='其他');
  if(length(input.otherHarness)>20 || (other && chosen.includes(String(other.id))&&!input.otherHarness))fields.otherHarness='请填写最多20字的其他工具名称';
  for(const key of ['demoUrl','sourceUrl'] as const) if(input[key]){try{input[key]=httpUrl(input[key]);}catch{fields[key]='只接受 http 或 https 地址';}}
  for(const [key,min,max] of [['cropX',0,100],['cropY',0,100],['cropZoom',1,3]] as const){const n=Number(input[key]);if(!Number.isFinite(n)||n<min||n>max)fields.coverId='封面裁剪范围无效';}
  if(Object.keys(fields).length)throw new FormError('请检查作品信息',fields);
}
export function getWork(db:Db,id:number,viewer:User|null):Work|undefined {
  const row=db.prepare('SELECT w.*,i.url cover_url,i.thumb_url cover_thumb FROM works w JOIN images i ON i.id=w.cover_id WHERE w.post_id=?').get(id) as Omit<Work,'post'|'harnesses'>|undefined;
  if(!row)return undefined;
  return {...row,post:getPost(db,id,viewer),harnesses:db.prepare('SELECT h.id,h.name FROM work_harnesses wh JOIN harnesses h ON h.id=wh.harness_id WHERE wh.post_id=? ORDER BY h.position,h.id').all(id) as {id:number;name:string}[]};
}
export function editWork(work:Work|undefined):WorkInput {return work?{...blankWork(),summary:work.summary,coverId:work.cover_id,demoUrl:work.demo_url,sourceUrl:work.source_url,otherHarness:work.other_harness,harnesses:work.harnesses.map(h=>String(h.id))}:blankWork();}
export async function prepareCover(db:Db,storage:Storage,user:User,input:WorkInput,now:number,old?:Work) {
  const image=db.prepare('SELECT * FROM images WHERE id=?').get(input.coverId) as {owner_id:number;key:string}|undefined;
  if(!image || (image.owner_id!==user.id && old?.cover_id!==input.coverId))throw new FormError('请选择自己上传的封面',{coverId:'封面不存在或不属于你'});
  if(old?.cover_id===input.coverId && input.cropX==='50'&&input.cropY==='50'&&input.cropZoom==='1')return input.coverId;
  const bytes=await storage.get(image.key);
  const oriented=await sharp(bytes,{limitInputPixels:40_000_000}).rotate().toBuffer();
  const meta=await sharp(oriented).metadata(),width=meta.width!,height=meta.height!;
  const zoom=Number(input.cropZoom),cropWidth=Math.max(1,Math.floor(Math.min(width,height*1.6)/zoom)),cropHeight=Math.max(1,Math.floor(cropWidth/1.6));
  const cropped=await sharp(oriented).extract({left:Math.round((width-cropWidth)*Number(input.cropX)/100),top:Math.round((height-cropHeight)*Number(input.cropY)/100),width:cropWidth,height:cropHeight}).resize(1600,1000).webp({quality:85}).toBuffer();
  return (await saveImage(db,storage,user.id,cropped,now)).id;
}
export function writeWork(db:Db,id:number,input:WorkInput,coverId:string) {
  db.prepare('INSERT INTO works(post_id,summary,cover_id,demo_url,source_url,other_harness) VALUES (?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET summary=excluded.summary,cover_id=excluded.cover_id,demo_url=excluded.demo_url,source_url=excluded.source_url,other_harness=excluded.other_harness').run(id,input.summary,coverId,input.demoUrl,input.sourceUrl,input.otherHarness);
  db.prepare('DELETE FROM work_harnesses WHERE post_id=?').run(id);
  for(const harness of input.harnesses)db.prepare('INSERT INTO work_harnesses VALUES (?,?)').run(id,harness);
  db.prepare('UPDATE posts SET work_summary=? WHERE id=?').run(input.summary,id);
}
export function selectedWorks(db:Db,viewer:User|null,count=4,filter={range:'all',harness:''},now=Date.now()) {
  const ids=db.prepare("SELECT w.post_id FROM works w JOIN posts p ON p.id=w.post_id JOIN users u ON u.id=p.author_id WHERE w.selected_at IS NOT NULL AND p.status='public' AND u.banned=0 AND u.profile_pending=0 AND p.created_at>=@since AND (@harness='' OR EXISTS(SELECT 1 FROM work_harnesses wh WHERE wh.post_id=p.id AND wh.harness_id=@harness)) ORDER BY w.selected_at DESC,p.id DESC LIMIT @count").all({since:since(filter.range,now),harness:filter.harness,count}) as {post_id:number}[];
  return ids.map(x=>getWork(db,x.post_id,viewer)!);
}
export function homeWorks(db:Db,viewer:User|null,now:number) {
  const ids=db.prepare("SELECT p.id FROM works w JOIN posts p ON p.id=w.post_id JOIN users u ON u.id=p.author_id WHERE p.status='public' AND u.banned=0 AND u.profile_pending=0 ORDER BY (p.created_at>=@since) DESC,CASE WHEN p.created_at>=@since THEN (SELECT COUNT(*) FROM votes v WHERE v.post_id=p.id) ELSE 0 END DESC,p.created_at DESC,p.id DESC LIMIT 4").all({since:now-14*86400000}) as {id:number}[];
  return ids.map(x=>getWork(db,x.id,viewer)!);
}
export function userWorks(db:Db,viewer:User|null,authorId:number) {
  return (db.prepare("SELECT p.id FROM works w JOIN posts p ON p.id=w.post_id JOIN users u ON u.id=p.author_id WHERE p.author_id=? AND p.status='public' AND u.banned=0 AND u.profile_pending=0 ORDER BY p.created_at DESC LIMIT 30").all(authorId) as {id:number}[]).map(x=>getWork(db,x.id,viewer)!);
}
export function worksPage(db:Db,viewer:User|null,options:{sort:string;range:string;harness:string;cursor?:string},now:number):WorkPageData {
  const result=feed(db,viewer,'works',{sort:options.sort==='latest'?'created':'votes',range:options.range,category:'4',tag:'',harness:options.harness,cursor:options.cursor},now,'/works');
  let next=result.next;
  if(next){const url=new URL(next,'http://localhost');url.searchParams.set('sort',options.sort);next=url.pathname+url.search;}
  return {works:result.posts.map(p=>getWork(db,p.id,viewer)!),selected:selectedWorks(db,viewer,4,options,now),harnesses:harnesses(db),sort:options.sort,range:options.range,harness:options.harness,next};
}
