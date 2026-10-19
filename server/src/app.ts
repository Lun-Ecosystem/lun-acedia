import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { ActionRegistry } from './contract/actions.ts';
import { codeExpiry, issuePairingCode, requireToken } from './contract/auth.ts';
import { contractRoutes } from './contract/routes.ts';
import type { GoogleDeps } from './google/client.ts';
import { googleRoutes } from './google/oauth.ts';

/** Everything the app needs; later tasks add their own dependencies here. */
export interface AppDeps {
  db: DatabaseSync;
  clock: () => Date;
  version: string;
  actions: ActionRegistry;
  /** Absent when GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or ACEDIA_SECRET_KEY is missing. */
  google?: GoogleDeps | undefined;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/lun/v1', contractRoutes(deps));

  const api = new Hono();
  api.use('*', requireToken(deps.db));
  api.post('/pairing-codes', (c) => {
    const code = issuePairingCode(deps.db, deps.clock());
    return c.json({ code, expiresAt: codeExpiry(deps.db, code) });
  });
  app.route('/api', api);

  const google = googleRoutes(deps);
  app.route('/oauth', google.callback);
  app.route('/api/google', google.api);

  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
}
