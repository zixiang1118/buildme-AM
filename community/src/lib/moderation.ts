import type { Db } from '../db/index.js';
import type { User } from '../types.js';
import { FormError } from './validation.js';
import { newAccount } from './posts.js';
export const reportReasons=['广告','与主题无关','不友善','违法违规','其他'];
export function firstPostReview(db:Db) {return (db.prepare("SELECT value FROM site_settings WHERE key='first_post_review'").get() as {value:string}).value==='1';}
export function checkWords(db:Db,text:string):'public'|'pending' {
  const value=text.normalize('NFKC').toLowerCase();
  const rows=db.prepare('SELECT word,level FROM blocked_words').all() as {word:string;level:string}[];
  let status:'public'|'pending'='public';
  for(const row of rows)if(value.includes(row.word.normalize('NFKC').toLowerCase())) {
    if(row.level==='reject')throw new FormError('内容包含不允许的词语');
    status='pending';
  }
  return status;
}
export function queueProfile(db:Db,userId:number,username:string,bio:string,now:number) {
  db.prepare('INSERT INTO pending_profiles VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,bio=excluded.bio,created_at=excluded.created_at').run(userId,username,bio,now);
}
const normalized=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{N}]/gu,'');
export function rejectDuplicate(db:Db,userId:number,text:string,now:number) {
  const previous=db.prepare("SELECT content FROM (SELECT title||body||link content,created_at FROM posts WHERE author_id=@user UNION ALL SELECT body content,created_at FROM replies WHERE author_id=@user) WHERE created_at>@since ORDER BY created_at DESC LIMIT 1").get({user:userId,since:now-600000}) as {content:string}|undefined;
  if(previous && normalized(previous.content)===normalized(text))throw new FormError('请勿在10分钟内重复提交相同或相似内容');
}
export function externalLinks(text:string,siteUrl:string) {
  return [...text.replace(/!\[[^\]]*\]\([^)]+\)/g,'').matchAll(/https?:\/\/[^\s<>"')]+/g)].flatMap(match=>{
    try {const url=new URL(match[0]);return url.origin===siteUrl?[]:[url.hostname.toLowerCase()];} catch {return [];}
  });
}
export function moderationStatus(db:Db,user:User,text:string,now:number,siteUrl:string) {
  const status=checkWords(db,text);
  if(status==='pending'||!newAccount(db,user,now))return status;
  const domains=new Set(externalLinks(text,siteUrl));if(!domains.size)return status;
  const previous=db.prepare("SELECT body||' '||link||' '||work_summary content FROM posts WHERE author_id=@user AND created_at>@since UNION ALL SELECT body content FROM replies WHERE author_id=@user AND created_at>@since").all({user:user.id,since:now-86400000}) as {content:string}[];
  const counts=new Map<string,number>();
  for(const row of previous)for(const domain of new Set(externalLinks(row.content,siteUrl)))counts.set(domain,(counts.get(domain)??0)+1);
  return [...domains].some(domain=>(counts.get(domain)??0)>=3)?'pending':'public';
}
