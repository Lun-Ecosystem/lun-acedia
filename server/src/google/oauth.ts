import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { requireToken } from '../contract/auth.ts';
import { getSetting, putSetting } from '../db.ts';
import { isSecretKey } from '../crypto.ts';
import { envOf } from '../util.ts';
import {
  forgetTokens,
  loadTokens,
  saveTokens,
  tokensUnreadable,
  TOKEN_URL,
  type GoogleConfig,
  type GoogleDeps,
} from './client.ts';

/** `gmail.settings.basic` lets Acedia read the "Send mail as" addresses. */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
];

const STATE_TTL_MS = 10 * 60_000;
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

/** Google's short error code, for the server log only, and only a bare word: never a description or a body. */
const shortCode = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z_]{1,64}$/.test(value) ? ` (${value})` : '';

export function authUrl(config: GoogleConfig, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.href;
}

/** Reads the Google configuration from the environment; `undefined` when it is incomplete or the key malformed. */
export function googleFromEnv(env: NodeJS.ProcessEnv): GoogleDeps | undefined {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ACEDIA_SECRET_KEY } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !ACEDIA_SECRET_KEY || !isSecretKey(ACEDIA_SECRET_KEY))
    return undefined;
  return {
    config: {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri:
        envOf('GOOGLE_REDIRECT_URI', env) ?? `http://localhost:${envOf('PORT', env) ?? 8787}/oauth/callback`,
    },
    secretKey: ACEDIA_SECRET_KEY,
    fetch,
  };
}

/**
 * Everything that belongs to one Google account: its cache, sync points, label roles, rules,
 * proposals, examples, journal and agenda. Label ids are numbered per account, so none of it can
 * follow to another one. Settings, paired clients and events stay.
 */
const ACCOUNT_TABLES = [
  'messages',
  'labels',
  'sync_state',
  'label_roles',
  'rules',
  'journal',
  'proposals',
  'examples',
  'triage_queue',
  'calendars',
  'calendar_events',
  'task_lists',
  'tasks',
  'reminders_sent',
];

export function forgetAccountData(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    for (const table of ACCOUNT_TABLES) db.exec(`DELETE FROM ${table}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** `/oauth/callback` (public: Google redirects the browser there) and `/api/google/*`. */
export function googleRoutes(deps: AppDeps): { callback: Hono; api: Hono } {
  const { db, clock, google } = deps;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const callback = new Hono();
  const api = new Hono();
  api.use('*', requireToken(db));

  api.get('/status', (c) => {
    const tokens = google ? loadTokens(db, google.secretKey) : undefined;
    if (tokens) return c.json({ connected: true, email: tokens.email });
    return c.json(
      google && tokensUnreadable(db, google.secretKey)
        ? { connected: false, unreadable: true }
        : { connected: false },
    );
  });

  if (!google) {
    api.all('*', (c) => c.json({ error: 'Google n’est pas configuré sur ce serveur' }, 503));
    return { callback, api };
  }

  api.get('/auth-url', (c) => {
    const state = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?, ?)').run(
      state,
      clock().toISOString(),
    );
    return c.json({ url: authUrl(google.config, state) });
  });

  api.post('/disconnect', async (c) => {
    const tokens = loadTokens(db, google.secretKey);
    if (tokens) {
      await google
        .fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refreshToken)}`, {
          method: 'POST',
        })
        .catch(() => undefined);
    }
    forgetTokens(db);
    return c.json({ connected: false });
  });

  // Four fixed addresses: nothing Google sends is copied back. Only a fresh state proves the return comes from
  // Google (RFC 6749, § 4.1.2.1); without one, anybody could forge it.
  callback.get('/callback', async (c) => {
    const state = c.req.query('state') ?? '';
    const row = db.prepare('SELECT created_at FROM oauth_states WHERE state = ?').get(state) as
      { created_at: string } | undefined;
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    const fresh = row && clock().getTime() - new Date(row.created_at).getTime() <= STATE_TTL_MS;
    if (!fresh) return c.redirect('/?google=expired', 302);
    const failed = (why: string) => {
      log(`Retour Google en échec : ${why}`);
      return c.redirect('/?google=failed', 302);
    };
    const error = c.req.query('error');
    if (error === 'access_denied') return c.redirect('/?google=refused', 302);
    const code = c.req.query('code');
    if (error !== undefined || !code) return failed(`retour sans code${shortCode(error)}`);

    // Nothing is stored before the profile is read with the token just received: a failure leaves the account
    // already connected as it was, its tokens and its address.
    let step = 'Google injoignable';
    let email: string;
    try {
      const res = await google.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: google.config.clientId,
          client_secret: google.config.clientSecret,
          redirect_uri: google.config.redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: unknown;
      };
      if (!res.ok || !body.access_token || !body.refresh_token) {
        return failed(`échange ${res.status}${shortCode(body.error)}`);
      }
      const me = await google.fetch(PROFILE_URL, {
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      const profile = (await me.json().catch(() => ({}))) as {
        emailAddress?: unknown;
        error?: { errors?: { reason?: unknown }[] };
      };
      if (!me.ok || typeof profile.emailAddress !== 'string' || !profile.emailAddress) {
        return failed(`profil ${me.status}${shortCode(profile.error?.errors?.[0]?.reason)}`);
      }
      email = profile.emailAddress;
      step = 'jetons non enregistrés';
      saveTokens(db, google.secretKey, {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: new Date(clock().getTime() + (body.expires_in ?? 3600) * 1000).toISOString(),
        email,
      });
    } catch {
      return failed(step);
    }
    // No await from saveTokens on: a sync cannot read the new tokens on the old account's data.
    const previous = getSetting<string | null>(db, 'google.account', null);
    if (previous !== null && previous !== email) forgetAccountData(db);
    putSetting(db, 'google.account', email);
    return c.redirect('/?google=connected', 302);
  });

  return { callback, api };
}
