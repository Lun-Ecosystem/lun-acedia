import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { agendaRoutes } from './agenda/routes.ts';
import type { ActionRegistry } from './contract/actions.ts';
import { registerCatalog } from './contract/catalog.ts';
import {
  bearerToken,
  codeExpiry,
  hashToken,
  issuePairingCode,
  listClients,
  requireDevice,
  requireToken,
  revokeClient,
} from './contract/auth.ts';
import { allowAuthorization, denyAuthorization, readAuthorizationRequest } from './contract/authorize.ts';
import { contractRoutes } from './contract/routes.ts';
import { gmailRoutes, sendAsRoutes } from './gmail/routes.ts';
import { createGoogleClient, type GoogleClient, type GoogleDeps } from './google/client.ts';
import { googleRoutes } from './google/oauth.ts';
import {
  ANTHROPIC_LABEL,
  anthropicKeyView,
  checkWithModelsList,
  keyWorks,
  saveAnthropicKey,
  type AnthropicEnv,
  type KeyChecker,
} from './keys/anthropic-key.ts';
import { checkExpiry, isValidDate } from './keys/expiry.ts';
import { serveApp } from './static.ts';
import { onManualFile, withProposal } from './triage/pipeline.ts';
import { triageRoutes } from './triage/routes.ts';

/** Everything the app needs; later tasks add their own dependencies here. */
export interface AppDeps {
  db: DatabaseSync;
  clock: () => Date;
  version: string;
  actions: ActionRegistry;
  /** Absent when GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or ACEDIA_SECRET_KEY is missing. */
  google?: GoogleDeps | undefined;
  /** The built standalone app (app/dist), served at the root when present. */
  staticDir?: string | undefined;
  /** Where warnings go (the pairing lock); `console.warn` by default. */
  log?: ((line: string) => void) | undefined;
  /** ACEDIA_SECRET_KEY: without it, no Anthropic key can be saved. */
  secretKey?: string | undefined;
  /** The Anthropic key and its expiry declared in `.env`. */
  anthropicEnv?: AnthropicEnv | undefined;
  /** How a new Anthropic key is tried; the free models listing by default. */
  checkAnthropicKey?: KeyChecker | undefined;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const google: GoogleClient | undefined = deps.google
    ? createGoogleClient({ db: deps.db, now: deps.clock, ...deps.google })
    : undefined;
  registerCatalog(deps.actions, { db: deps.db, google, clock: deps.clock });
  app.route('/lun/v1', contractRoutes(deps));
  // Every /api route, whichever module mounts it, is for paired devices only.
  app.use('/api/*', requireToken(deps.db), requireDevice(deps.db));

  const api = new Hono();
  api.post('/pairing-codes', (c) => {
    const code = issuePairingCode(deps.db, deps.clock());
    return c.json({ code, expiresAt: codeExpiry(deps.db, code) });
  });
  api.get('/clients', (c) => {
    const mine = hashToken(bearerToken(c.req.header('authorization')));
    const clients = listClients(deps.db).map(({ tokenHash, ...client }) => ({
      ...client,
      current: tokenHash === mine,
    }));
    return c.json({ clients });
  });
  api.delete('/clients/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || !revokeClient(deps.db, id, deps.clock()))
      return c.json({ error: 'Client inconnu' }, 404);
    return c.body(null, 204);
  });
  api.post('/authorizations', async (c) => {
    // Device only, like the whole /api surface (requireDevice above).
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Corps JSON invalide' }, 400);
    }
    if (body === null || typeof body !== 'object') return c.json({ error: 'Corps JSON invalide' }, 400);
    const read = readAuthorizationRequest(body);
    if ('error' in read) return c.json({ error: read.error }, 400);
    if (body.decision === 'allow')
      return c.json({ redirect: allowAuthorization(deps.db, read.request, deps.clock()) });
    if (body.decision === 'deny') return c.json({ redirect: denyAuthorization(read.request) });
    return c.json({ error: "decision attendue : 'allow' ou 'deny'" }, 400);
  });
  const anthropicEnv = deps.anthropicEnv ?? {};
  api.get('/anthropic-key', (c) => c.json(anthropicKeyView(deps.db, deps.secretKey, anthropicEnv)));
  // The key is never logged nor sent back: the answer carries its last 4 characters at most.
  api.put('/anthropic-key', async (c) => {
    if (!deps.secretKey)
      return c.json({ error: 'ACEDIA_SECRET_KEY absente : la clé ne peut pas être enregistrée' }, 400);
    let body: { key?: unknown; expires?: unknown };
    try {
      body = (await c.req.json()) as { key?: unknown; expires?: unknown };
    } catch {
      return c.json({ error: 'Corps JSON invalide' }, 400);
    }
    if (body === null || typeof body !== 'object') return c.json({ error: 'Corps JSON invalide' }, 400);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) return c.json({ error: 'Clé attendue' }, 400);
    // No date (absent, null or empty) is fine; anything else must be a real AAAA-MM-JJ.
    const rawExpires = body.expires ?? '';
    const expires = typeof rawExpires === 'string' ? rawExpires.trim() || undefined : '';
    if (expires !== undefined && !isValidDate(expires))
      return c.json({ error: 'Date d’échéance attendue au format AAAA-MM-JJ' }, 400);
    const check = await (deps.checkAnthropicKey ?? checkWithModelsList)(key);
    if (check === 'refused') return c.json({ error: 'Clé refusée par Anthropic, rien n’a changé' }, 400);
    if (check === 'unreachable') return c.json({ error: 'Anthropic injoignable, rien n’a changé' }, 502);
    saveAnthropicKey(deps.db, deps.secretKey, key, expires);
    keyWorks(deps.db, deps.clock());
    checkExpiry(deps.db, deps.clock(), expires, ANTHROPIC_LABEL);
    return c.json(anthropicKeyView(deps.db, deps.secretKey, anthropicEnv));
  });
  app.route('/api', api);

  const auth = googleRoutes(deps);
  app.route('/oauth', auth.callback);
  app.route('/api/google', auth.api);
  app.route(
    '/api/mail',
    gmailRoutes(deps, google, {
      decorate: (m) => withProposal(deps.db, m),
      onFile: (id, boxId) => onManualFile({ db: deps.db, google: google!, now: deps.clock }, id, boxId),
    }),
  );
  app.route('/api/send-as', sendAsRoutes(deps, google));
  app.route('/api', triageRoutes(deps, google));
  app.route('/api', agendaRoutes(deps, google));
  if (deps.staticDir) serveApp(app, deps.staticDir);

  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
}
