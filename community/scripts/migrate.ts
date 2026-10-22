import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
const config=readConfig(),db=openDb(join(config.dataDir,'community.sqlite'));db.close();console.log(JSON.stringify({event:'migrations_applied'}));
