import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { startReminderLoop } from './agenda/reminders.ts';
import { syncAgenda } from './agenda/unified.ts';
import { createApp } from './app.ts';
import { ActionRegistry } from './contract/actions.ts';
import { bootstrapPairing } from './contract/auth.ts';
import { pruneEvents } from './contract/events.ts';
import { openDb } from './db.ts';
import { startSyncLoop } from './gmail/sync.ts';
import { createGoogleClient, GoogleNotConnectedError, GoogleReauthError } from './google/client.ts';
import { googleFromEnv } from './google/oauth.ts';
import { createAnthropicClassifier } from './triage/anthropic.ts';
import { triageNew } from './triage/pipeline.ts';
import { recoverQueue } from './triage/queue.ts';
import { startLoop } from './util.ts';

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
const google = googleFromEnv(process.env);
if (!google)
  console.log(
    'Google non configuré : renseigner GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et ACEDIA_SECRET_KEY.',
  );
const appDist = resolve(root, 'app/dist');
const staticDir = existsSync(resolve(appDist, 'index.html')) ? appDist : undefined;
if (!staticDir) console.log('Front autonome absent : lancer « npm run build -w @lun-acedia/app ».');
const app = createApp({ db, clock, version, actions, google, staticDir });

bootstrapPairing(db, clock(), (line) => console.log(line));
const classifier = process.env.ANTHROPIC_API_KEY
  ? createAnthropicClassifier({ apiKey: process.env.ANTHROPIC_API_KEY })
  : undefined;
if (!classifier) console.log('ANTHROPIC_API_KEY absente : seules les règles trient les mails.');
function logError(what: string) {
  return (err: unknown) => {
    // Not connected yet, or waiting for a new consent: health already says so.
    if (err instanceof GoogleNotConnectedError || err instanceof GoogleReauthError) return;
    console.error(`${what} :`, err);
  };
}
// Claims left by a stop in the middle of a triage go back to the queue.
recoverQueue(db);
if (google) {
  const deps = { db, google: createGoogleClient({ db, now: clock, ...google }), now: clock };
  startSyncLoop(deps, {
    // The sync queues the new mails; the triage drains the queue (also what waited for a resume).
    onResult: () => triageNew({ ...deps, classifier }),
    onError: logError('Synchro Gmail'),
  });
  // The agenda has its own loop: a Gmail or AI failure never stops it.
  startLoop(() => syncAgenda(deps), {
    intervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 60_000),
    onError: logError('Synchro Agenda'),
  });
}
startReminderLoop(db, clock);
setInterval(() => pruneEvents(db, clock()), 3600_000).unref();

const port = Number(process.env.PORT ?? 8787);
// Loopback by default: a deployment that must be reachable gives its address explicitly.
const hostname = process.env.HOST?.trim() || '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, () => console.log(`Lun'Acedia écoute sur ${hostname}:${port}`));
