import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { LocalStorage,OssStorage } from '../src/lib/storage.js';
import { migrateImages } from '../src/lib/maintenance.js';
const config=readConfig({...process.env,STORAGE_DRIVER:'oss'}),db=openDb(join(config.dataDir,'community.sqlite'));
try {console.log(JSON.stringify({event:'images_migrated',count:await migrateImages(db,new LocalStorage(join(config.dataDir,'media')),new OssStorage(config))}));} finally {db.close();}
