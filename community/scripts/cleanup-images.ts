import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createStorage } from '../src/lib/storage.js';
import { cleanupImages } from '../src/lib/maintenance.js';
const config=readConfig(),db=openDb(join(config.dataDir,'community.sqlite'));
try {console.log(JSON.stringify({event:'images_cleaned',count:await cleanupImages(db,createStorage(config))}));} finally {db.close();}
