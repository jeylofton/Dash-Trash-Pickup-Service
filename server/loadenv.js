/* Load environment variables from server/.env regardless of the current
   working directory. `import 'dotenv/config'` reads cwd/.env, which breaks
   when the server is launched from the repo root (node server/server.js)
   instead of from inside server/. Importing this module first guarantees
   the .env next to the server code is loaded before anything reads it. */
import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });
