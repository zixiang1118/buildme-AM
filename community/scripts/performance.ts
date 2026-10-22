import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import sharp from 'sharp';
import { openDb } from '../src/db/index.js';
import { readConfig } from '../src/config.js';
import { createStorage } from '../src/lib/storage.js';
import { saveImage } from '../src/lib/images.js';
import { refreshHot } from '../src/lib/browse.js';
const directory=process.env.BENCH_DATA_DIR??await mkdtemp(join(tmpdir(),'buildme-perf-')),now=Date.now();
const config=readConfig({DATA_DIR:directory,SESSION_SECRET:'performance-isolated-secret-not-production'}),db=openDb(join(directory,'community.sqlite'));
if(!process.env.BENCH_DATA_DIR){
 db.transaction(()=>{const insert=db.prepare("INSERT INTO users(id,username,username_key,created_at,first_post_approved) VALUES(?,?,?, ?,1)");for(let i=1;i<=1000;i++)insert.run(i,`基准用户${i}`,`基准用户${i}`,now-40*86400000);})();
 const image=await saveImage(db,createStorage(config),1,await sharp({create:{width:160,height:100,channels:3,background:'#c4582f'}}).webp().toBuffer(),now);
 const long='我们记录模型工具调用和可复现的学习过程。'.repeat(600).slice(0,10000);
 db.transaction(()=>{
  const insert=db.prepare("INSERT INTO posts(id,author_id,category_id,title,body,html,excerpt,status,created_at,last_activity) VALUES (?,?,?,?,?,?,?,'public',?,?)"),tag=db.prepare('INSERT INTO post_tags VALUES (?,1)'),work=db.prepare("INSERT INTO works(post_id,summary,cover_id,demo_url,source_url,other_harness) VALUES (?,?,?,'','','')"),tool=db.prepare('INSERT INTO work_harnesses VALUES (?,1)'),vote=db.prepare('INSERT INTO votes VALUES (?,?,?)');
  for(let i=1;i<=50000;i++){const body=i<=500?long:`这是第${i}次社区开发记录，${i%10===0?'harness 搜索对比':'实际调试经验'}。`,title=`${i%10===0?'harness':'社区'}开发记录${i}`,time=now-(50000-i)*30000;insert.run(i,i%1000+1,i>500&&i<=2500?4:1,title,body,`<p>${body}</p>`,body.slice(0,140),time,time);tag.run(i);if(i>500&&i<=2500){work.run(i,`可以试用的工具${i}`,image.id);tool.run(i);}if(i%5===0)for(let v=0;v<5;v++)vote.run(i,(i+v)%1000+1,now);}
  const reply=db.prepare('INSERT INTO replies(post_id,author_id,floor,body,html,created_at) VALUES (?,?,?,?,?,?)');for(let i=0;i<200;i++)reply.run(1,i%1000+1,i+1,`200楼讨论${i}`,`<p>200楼讨论${i}</p>`,now);
  for(let i=0;i<199800;i++){const post=i%49999+2,floor=Math.floor(i/49999)+1,body=`回复${i}：一次实际实践记录。`;reply.run(post,i%1000+1,floor,body,`<p>${body}</p>`,now);}
 })();db.exec('ANALYZE');
}
const counts=db.prepare('SELECT (SELECT count(*) FROM posts) posts,(SELECT count(*) FROM replies) replies,(SELECT count(*) FROM users) users,(SELECT count(*) FROM works) works,(SELECT count(*) FROM posts WHERE length(body)=10000) longArticles').get() as {posts:number;replies:number;users:number;works:number;longArticles:number};if(counts.posts!==50000||counts.replies!==200000||counts.users!==1000||counts.works!==2000||counts.longArticles!==500)throw new Error('基准数据量不正确');refreshHot(db,now);db.close();console.log(JSON.stringify({event:'seeded',directory,users:1000,posts:50000,longArticles:500,works:2000,replies:200000}));
const server=spawn(process.execPath,['dist/src/server.js'],{env:{...process.env,SESSION_SECRET:config.sessionSecret,DATA_DIR:directory,SITE_URL:'http://localhost:3196',PORT:'3196',TRUST_PROXY:'true'},stdio:['ignore','pipe','pipe']});
await new Promise<void>((resolve,reject)=>{server.stdout.on('data',chunk=>{if(chunk.toString().includes('listening'))resolve();});server.once('exit',code=>reject(Error(`server exited ${code}`)));});
const duration=Number(process.env.BENCH_SECONDS??30)*1000,concurrency=50,results=[];
const agents=Array.from({length:concurrency},()=>new http.Agent({keepAlive:true,maxSockets:1}));let ip=0;
function request(path:string,cookie:string,agent:http.Agent) {return new Promise<{ms:number;status:number;cookie:string}>((resolve,reject)=>{const start=performance.now(),n=ip++,req=http.get({hostname:'127.0.0.1',port:3196,path,headers:{cookie,'accept-encoding':'gzip','x-forwarded-for':`198.${Math.floor(n/65536)%256}.${Math.floor(n/256)%256}.${n%256}`},agent},res=>{res.resume();res.once('end',()=>resolve({ms:performance.now()-start,status:res.statusCode!,cookie:res.headers['set-cookie']?.find(x=>x.startsWith('community_session='))?.split(';')[0]??cookie}));});req.once('error',reject);});}
try {
 for(const path of (process.argv.length>2?process.argv.slice(2):['/','/latest','/works','/p/1','/search?q=harness'])) {
  const cold=await request(path,'',agents[0]);if(cold.status!==200)throw new Error(`基准页面不可用: ${path}`);const times:number[]=[],codes:Record<string,number>={},start=performance.now();
  await Promise.all(agents.map(async agent=>{let cookie='';while(performance.now()-start<duration){const result=await request(path,cookie,agent);cookie=result.cookie;times.push(result.ms);codes[result.status]=(codes[result.status]??0)+1;}}));
  times.sort((a,b)=>a-b);const p95=times[Math.floor(times.length*.95)],result={path,seconds:duration/1000,concurrency,requests:times.length,p95Ms:Math.round(p95*100)/100,p99Ms:Math.round(times[Math.floor(times.length*.99)]*100)/100,maxMs:Math.round(times.at(-1)!*100)/100,firstRequestMs:Math.round(cold.ms*100)/100,statuses:codes,pass:p95<=(path.startsWith('/search')?300:150)&&Object.keys(codes).every(k=>k==='200')};results.push(result);console.log(JSON.stringify(result));
 }
 const report={at:new Date().toISOString(),hardware:{platform:platform(),arch:arch(),cpu:cpus()[0].model,cores:cpus().length,memoryGiB:Math.round(totalmem()/2**30)},dataset:{users:1000,posts:50000,longArticles:500,works:2000,replies:200000},results};await mkdir('output',{recursive:true});await writeFile(`output/performance${process.argv.length>2?'-targeted':''}.json`,JSON.stringify(report,null,2));if(results.some(r=>!r.pass))process.exitCode=1;
} finally {agents.forEach(a=>a.destroy());server.kill();await new Promise(resolve=>server.once('exit',resolve));}
