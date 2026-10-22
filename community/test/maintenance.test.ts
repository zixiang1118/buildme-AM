import { it,expect,vi } from 'vitest';
import { mkdtemp,readFile,writeFile,mkdir,cp,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { fixture,browser } from './helpers.js';
import { saveImage } from '../src/lib/images.js';
import { LocalStorage, type Storage } from '../src/lib/storage.js';
import { cleanupImages,migrateImages } from '../src/lib/maintenance.js';
import { openDb,migrate } from '../src/db/index.js';
import { SafeFetcher } from '../src/lib/remote.js';
it('D-4 孤儿清理删除双图并保护帖子、草稿、回复、头像与24小时内图片',async()=>{
 const f=await fixture(),storage=new LocalStorage(join(f.config.dataDir,'media')),bytes=await sharp({create:{width:20,height:20,channels:3,background:'#c4582f'}}).webp().toBuffer();
 const images=[];for(let i=0;i<6;i++)images.push(await saveImage(f.db,storage,1,bytes,f.now-(i===5?0:86400001)));
 f.db.prepare("INSERT INTO posts(id,author_id,category_id,title,body,html,excerpt,status,created_at,last_activity) VALUES(1,1,1,'清理引用测试','','','','public',?,?)").run(f.now,f.now);
 f.db.prepare("INSERT INTO replies(id,post_id,author_id,floor,body,html,created_at) VALUES(1,1,1,1,'','',?)").run(f.now);f.db.prepare("INSERT INTO drafts VALUES(1,1,'{}',?)").run(f.now);
 for(const [index,kind] of [[1,'post'],[2,'draft'],[3,'reply']] as const)f.db.prepare('INSERT INTO image_refs VALUES (?,?,1)').run(images[index].id,kind);
 f.db.prepare('UPDATE users SET avatar_url=? WHERE id=1').run(images[4].url);
 expect(await cleanupImages(f.db,storage,f.now)).toBe(1);await expect(readFile(join(f.config.dataDir,images[0].url))).rejects.toMatchObject({code:'ENOENT'});
 expect((await readdir(join(f.config.dataDir,'media'))).length).toBe(10);expect(await cleanupImages(f.db,storage,f.now)).toBe(0);await f.close();
});
it('D-2 在线备份包在另一个空目录恢复用户、帖子和图片，保留最近7份',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'buildme-backup-test-')),data=join(dir,'source'),backups=join(dir,'backups'),restored=join(dir,'restored'),db=openDb(join(data,'community.sqlite'));
 db.prepare("INSERT INTO users(id,username,username_key,created_at) VALUES(1,'备份成员','备份成员',1)").run();db.prepare("INSERT INTO posts(author_id,category_id,title,body,html,excerpt,status,created_at,last_activity) VALUES(1,1,1,'备份正文','<p>备份正文</p>','','public',1,1)").run();
 const image=await saveImage(db,new LocalStorage(join(data,'media')),1,await sharp({create:{width:20,height:20,channels:3,background:'red'}}).webp().toBuffer(),1);db.close();
 await mkdir(backups);for(let i=0;i<8;i++)await writeFile(join(backups,`community-2000-01-0${i+1}.tar.gz`),'old');
 const envFile=join(dir,'env');await writeFile(envFile,`SESSION_SECRET=backup-test-secret-longer-than-32-characters\nDATA_DIR=${data}\nBACKUP_DIR=${backups}\nBACKUP_REMOTE=local\n`);
 const output=execFileSync('bash',['deploy/backup.sh'],{env:{...process.env,COMMUNITY_ENV_FILE:envFile},encoding:'utf8'});expect(output).toContain('backup_complete');const archives=(await readdir(backups)).sort();expect(archives).toHaveLength(7);
 await mkdir(restored);execFileSync('tar',['-xzf',join(backups,archives.at(-1)!),'-C',restored]);const recovered=openDb(join(restored,'community.sqlite'));
 expect(recovered.pragma('integrity_check',{simple:true})).toBe('ok');expect(recovered.prepare('SELECT username FROM users').get()).toEqual({username:'备份成员'});expect(recovered.prepare('SELECT body FROM posts').get()).toEqual({body:'备份正文'});expect((await readFile(join(restored,image.url))).length).toBeGreaterThan(0);recovered.close();await rm(dir,{recursive:true,force:true});
});
it('D-3 从C5数据库升级后通知和参与者保留，重复迁移幂等',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'buildme-migrations-')),old=join(directory,'old');await mkdir(old);for(const name of await readdir('src/db/migrations'))if(name<'007')await cp(join('src/db/migrations',name),join(old,name));
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,old);db.exec("INSERT INTO users(id,username,username_key,created_at) VALUES(1,'迁移成员','迁移成员',1);INSERT INTO posts(id,author_id,category_id,title,body,html,excerpt,status,created_at,last_activity) VALUES(1,1,1,'迁移内容','','','','public',1,1);INSERT INTO notifications VALUES(1,1,1,'reply',1,0,1,1,NULL);INSERT INTO notification_actors VALUES(1,1)");
 migrate(db);migrate(db);expect(db.prepare('SELECT post_id,message FROM notifications').get()).toEqual({post_id:1,message:''});expect(db.prepare('SELECT * FROM notification_actors').get()).toEqual({notification_id:1,user_id:1});expect(db.pragma('foreign_key_check')).toEqual([]);db.close();await rm(directory,{recursive:true,force:true});
});
it('D-2 图片迁移同时更新缓存、草稿、历史、头像，重跑不重复上传',async()=>{
 const f=await fixture(),source=new LocalStorage(join(f.config.dataDir,'media')),files=new Map<string,Buffer>(),target:Storage={put:async(k,b)=>{files.set(k,b);},get:async k=>files.get(k)!,remove:async k=>{files.delete(k);},url:k=>`https://images.example/${k}`};
 const image=await saveImage(f.db,source,1,await sharp({create:{width:10,height:10,channels:3,background:'red'}}).webp().toBuffer(),1);
 f.db.prepare("INSERT INTO posts(id,author_id,category_id,title,body,html,excerpt,status,created_at,last_activity) VALUES(1,1,1,'迁移测试',?,?,'','public',1,1)").run(`![图](${image.url})`,`<img src="${image.url}">`);f.db.prepare('UPDATE users SET avatar_url=? WHERE id=1').run(image.url);f.db.prepare('INSERT INTO drafts VALUES(1,1,?,1)').run(JSON.stringify({body:image.url}));f.db.prepare('INSERT INTO post_versions VALUES(1,1,1,?,1)').run(JSON.stringify({body:image.url}));
 expect(await migrateImages(f.db,source,target)).toBe(1);expect(files.size).toBe(2);for(const [table,column] of [['posts','html'],['users','avatar_url'],['drafts','data'],['post_versions','data']])expect(Object.values(f.db.prepare(`SELECT ${column} FROM ${table}`).get() as object)[0]).toContain('https://images.example/');expect(await migrateImages(f.db,source,target)).toBe(0);await f.close();
});
it('S-1 S-2 首屏gzip资源总和≤300KB，本站哈希字体图标与安全响应头',async()=>{
 const f=await fixture(),response=await f.app.request('/'),html=await response.text();expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
 const files=new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)/g)].map(m=>m[1]));let total=gzipSync(html).length;
 for(const file of files){const res=await f.app.request(file);expect(res.status,file).toBe(200);const data=Buffer.from(await res.arrayBuffer());total+=gzipSync(data).length;expect(file).toMatch(/\.[a-f0-9]{12}\./);if(file.includes('.css'))for(const match of data.toString().matchAll(/url\('(\/fonts\/[^']+)'\)/g)){expect(match[1]).toMatch(/\.[a-f0-9]{12}\.woff2$/);total+=gzipSync(await readFile(join('public',match[1]))).length;}}
 expect(total).toBeLessThanOrEqual(300*1024);console.log(JSON.stringify({event:'homepage_gzip_bytes',bytes:total}));await f.close();
});
it('S-3 异常日志不含密码、Cookie、OAuth令牌与原始IP',async()=>{
 const secret='private-test-token',remote=new SafeFetcher();vi.spyOn(remote,'get').mockRejectedValue(Error(secret));const f=await fixture({remote}),b=browser(f.app),logs=vi.spyOn(console,'error').mockImplementation(()=>{});await b.login();await b.request('/new');
 await b.post('/links/resolve',{link:'https://example.com/private'},true);const output=JSON.stringify(logs.mock.calls);for(const value of [secret,'admin-password',b.cookie,'127.0.0.1'])expect(output).not.toContain(value);expect(output).toContain('request_failed');logs.mockRestore();await f.close();
});
it('S-1 M-5 M-9 匿名缓存更换每个会话的CSRF，内容修改立即失效，缓存不跳过搜索限流',async()=>{
 const f=await fixture(),a=browser(f.app),b=browser(f.app);await a.request('/latest');await b.request('/latest');expect(a.csrf).not.toBe(b.csrf);expect((await b.post('/theme',{theme:'dark'})).status).toBe(303);
 const admin=browser(f.app);await admin.login();await admin.request('/new');await admin.post('/new',{title:'缓存更新测试内容',body:'正文',category:'1'});expect(await(await a.request('/latest')).text()).toContain('缓存更新测试内容');await admin.post('/admin/content/post/1/action',{action:'delete'});expect(await(await a.request('/latest')).text()).not.toContain('缓存更新测试内容');
 for(let i=0;i<30;i++)expect((await a.request('/search?q=harness')).status).toBe(200);expect((await a.request('/search?q=harness')).status).toBe(429);await f.close();
});
