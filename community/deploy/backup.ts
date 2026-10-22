import { mkdir,mkdtemp,readdir,rm,readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { OssStorage } from '../src/lib/storage.js';
process.umask(0o077);
const config=readConfig(),destination=resolve(process.env.BACKUP_DIR??'./backups');await mkdir(destination,{recursive:true});
const stage=await mkdtemp(join(tmpdir(),'buildme-backup-')),name=`community-${new Date().toISOString().replaceAll(':','-')}.tar.gz`,archive=join(destination,name),db=openDb(join(config.dataDir,'community.sqlite'));
try {await db.backup(join(stage,'community.sqlite'));await mkdir(join(config.dataDir,'media'),{recursive:true});execFileSync('tar',['-czf',archive,'-C',stage,'community.sqlite','-C',config.dataDir,'media']);
 if(process.env.BACKUP_REMOTE==='oss'){
  const ossConfig=readConfig({...process.env,STORAGE_DRIVER:'oss',OSS_REGION:process.env.BACKUP_OSS_REGION,OSS_BUCKET:process.env.BACKUP_OSS_BUCKET,OSS_ACCESS_KEY_ID:process.env.BACKUP_OSS_ACCESS_KEY_ID,OSS_ACCESS_KEY_SECRET:process.env.BACKUP_OSS_ACCESS_KEY_SECRET,OSS_PUBLIC_URL:process.env.BACKUP_OSS_ENDPOINT});
  await new OssStorage(ossConfig).put(`backups/${name}`,await readFile(archive),'application/gzip');
 } else if(process.env.BACKUP_REMOTE!=='local')throw new Error('BACKUP_REMOTE 必须为 oss 或明确的 local 演练模式');
 const previous=(await readdir(destination)).filter(x=>/^community-.*\.tar\.gz$/.test(x)).sort().reverse();for(const old of previous.slice(7))await rm(join(destination,old));console.log(JSON.stringify({event:'backup_complete',archive,remote:process.env.BACKUP_REMOTE}));
} finally {db.close();await rm(stage,{recursive:true,force:true});}
