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
const app = createApp({ db, clock, version, actions, google });

bootstrapPairing(db, clock(), (line) => console.log(line));
const classifier = process.env.ANTHROPIC_API_KEY
  ? createAnthropicClassifier({ apiKey: process.env.ANTHROPIC_API_KEY })
  : undefined;
if (!classifier) console.log('ANTHROPIC_API_KEY absente : seules les règles trient les mails.');
if (google) {
  const deps = { db, google: createGoogleClient({ db, now: clock, ...google }), now: clock };
  startSyncLoop(deps, {
    onResult: async (result) => {
      await triageNew({ ...deps, classifier }, result.added);
      await syncAgenda(deps);
    },
    onError: (err) => {
      // Not connected yet, or waiting for a new consent: health already says so.
      if (err instanceof GoogleNotConnectedError || err instanceof GoogleReauthError) return;
      console.error('Synchro Gmail :', err);
    },
  });
}
startReminderLoop(db, clock);
setInterval(() => pruneEvents(db, clock()), 3600_000).unref();

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Lun'Acedia écoute sur le port ${port}`));
