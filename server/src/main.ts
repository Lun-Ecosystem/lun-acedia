import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { ActionRegistry } from './contract/actions.ts';
import { bootstrapPairing } from './contract/auth.ts';
import { pruneEvents } from './contract/events.ts';
import { openDb } from './db.ts';

// Paths are resolved from the repository root, whatever the working directory (npm -w runs in server/).
const root = fileURLToPath(new URL('../../', import.meta.url));
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const db = openDb(resolve(root, process.env.DB_PATH ?? 'data/acedia.db'));
const clock = () => new Date();
const actions = new ActionRegistry();
const app = createApp({ db, clock, version, actions });

bootstrapPairing(db, clock(), (line) => console.log(line));
setInterval(() => pruneEvents(db, clock()), 3600_000).unref();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Lun'Acedia écoute sur le port ${port}`));
