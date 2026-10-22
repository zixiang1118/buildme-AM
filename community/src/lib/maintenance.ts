import type { Db } from '../db/index.js';
import type { Storage } from './storage.js';
export async function cleanupImages(db:Db,storage:Storage,now=Date.now()) {
 const images=db.prepare(`SELECT i.* FROM images i WHERE i.created_at<? AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_url=i.url) AND NOT EXISTS(SELECT 1 FROM image_refs r WHERE r.image_id=i.id AND ((r.kind='draft' AND EXISTS(SELECT 1 FROM drafts d WHERE d.id=r.entity_id)) OR (r.kind='post' AND EXISTS(SELECT 1 FROM posts p WHERE p.id=r.entity_id AND p.status!='deleted')) OR (r.kind='reply' AND EXISTS(SELECT 1 FROM replies a JOIN posts p ON p.id=a.post_id WHERE a.id=r.entity_id AND a.deleted=0 AND p.status!='deleted')))) AND NOT EXISTS(SELECT 1 FROM works w JOIN posts p ON p.id=w.post_id WHERE w.cover_id=i.id AND p.status!='deleted')`).all(now-86400000) as {id:string;key:string;thumb_key:string;thumb_url:string}[];
 for(const image of images){
  await storage.remove(image.key);await storage.remove(image.thumb_key);
  db.transaction(()=>{db.prepare('DELETE FROM image_refs WHERE image_id=?').run(image.id);db.prepare('DELETE FROM work_harnesses WHERE post_id IN (SELECT post_id FROM works WHERE cover_id=?)').run(image.id);db.prepare('DELETE FROM works WHERE cover_id=?').run(image.id);db.prepare('DELETE FROM link_cache WHERE thumbnail=?').run(image.thumb_url);db.prepare('DELETE FROM images WHERE id=?').run(image.id);})();
 }
 db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);db.prepare('DELETE FROM feed_snapshots WHERE expires_at<?').run(now);db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(now);db.prepare('DELETE FROM rate_events WHERE happened_at<?').run(now-86400000);
 return images.length;
}
export async function migrateImages(db:Db,source:Storage,destination:Storage) {
 const images=db.prepare('SELECT * FROM images ORDER BY id').all() as {id:string;key:string;url:string;thumb_key:string;thumb_url:string;mime:string}[];
 const replacements=new Map<string,string>();
 for(const image of images){const url=destination.url(image.key),thumb=destination.url(image.thumb_key);if(image.url===url&&image.thumb_url===thumb)continue;await destination.put(image.key,await source.get(image.key),image.mime);await destination.put(image.thumb_key,await source.get(image.thumb_key),'image/webp');replacements.set(image.url,url);replacements.set(image.thumb_url,thumb);}
 const replace=(text:string)=>{for(const [from,to] of replacements)text=text.split(from).join(to);return text;};
 db.transaction(()=>{
  for(const image of images)db.prepare('UPDATE images SET url=?,thumb_url=? WHERE id=?').run(destination.url(image.key),destination.url(image.thumb_key),image.id);
  for(const [table,key,columns] of [['posts','id',['body','html','link_thumbnail']],['replies','id',['body','html']],['users','id',['avatar_url']],['drafts','id',['data']],['post_versions','id',['data']],['link_cache','url',['thumbnail']]] as const){
   const rows=db.prepare(`SELECT ${key},${columns.join(',')} FROM ${table}`).all() as Record<string,string|number|null>[];
   const update=db.prepare(`UPDATE ${table} SET ${columns.map(c=>`${c}=?`).join(',')} WHERE ${key}=?`);
   for(const row of rows){const values=columns.map(c=>row[c]===null?null:replace(String(row[c])));if(columns.some((c,i)=>values[i]!==row[c]))update.run(...values,row[key]);}
  }
  db.prepare('DELETE FROM cache_entries').run();
 })();return replacements.size/2;
}
