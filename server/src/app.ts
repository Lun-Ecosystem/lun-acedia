import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { ActionRegistry } from './contract/actions.ts';
import { codeExpiry, issuePairingCode, requireToken } from './contract/auth.ts';
import { contractRoutes } from './contract/routes.ts';

/** Everything the app needs; later tasks add their own dependencies here. */
export interface AppDeps {
  db: DatabaseSync;
  clock: () => Date;
  version: string;
  actions: ActionRegistry;
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

  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
}
