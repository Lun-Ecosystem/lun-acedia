import type { DatabaseSync } from 'node:sqlite';
import { emitEvent } from '../contract/events.ts';
import { addDegraded, clearDegraded, getState } from '../contract/state.ts';
import { decrypt, encrypt } from '../crypto.ts';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REAUTH = 'google-reauth';
const EXPIRY_MARGIN_MS = 60_000;
const MAX_RETRIES = 3;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** What the app needs to talk to Google; absent when Google is not configured. */
export interface GoogleDeps {
  config: GoogleConfig;
  secretKey: string;
  fetch: typeof fetch;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  email?: string;
}

export class GoogleReauthError extends Error {
  constructor() {
    super('Autorisation Google à renouveler');
    this.name = 'GoogleReauthError';
  }
}

export class GoogleNotConnectedError extends Error {
  constructor() {
    super('Aucun compte Google branché');
    this.name = 'GoogleNotConnectedError';
  }
}

export class GoogleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`Google ${status} : ${message}`);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}

export function saveTokens(db: DatabaseSync, secretKey: string, t: Tokens): void {
  db.prepare(
    `INSERT INTO google_tokens (id, access_token, refresh_token, expires_at, email) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
       email = COALESCE(excluded.email, google_tokens.email)`,
  ).run(encrypt(t.accessToken, secretKey), encrypt(t.refreshToken, secretKey), t.expiresAt, t.email ?? null);
  clearDegraded(db, REAUTH);
}

export function loadTokens(db: DatabaseSync, secretKey: string): Tokens | undefined {
  const row = db.prepare('SELECT * FROM google_tokens WHERE id = 1').get() as
    { access_token: string; refresh_token: string; expires_at: string; email: string | null } | undefined;
  if (!row) return undefined;
  const t: Tokens = {
    accessToken: decrypt(row.access_token, secretKey),
    refreshToken: decrypt(row.refresh_token, secretKey),
    expiresAt: row.expires_at,
  };
  if (row.email) t.email = row.email;
  return t;
}

export function forgetTokens(db: DatabaseSync): void {
  db.prepare('DELETE FROM google_tokens').run();
  clearDegraded(db, REAUTH);
}

export interface GoogleClient {
  /** Calls a Google JSON API; `undefined` for an empty answer (204). */
  request<T>(method: string, url: string, body?: unknown): Promise<T>;
}

export interface ClientOptions {
  db: DatabaseSync;
  fetch: typeof fetch;
  now: () => Date;
  config: GoogleConfig;
  secretKey: string;
  sleep?: (ms: number) => Promise<void>;
}

export function createGoogleClient(opts: ClientOptions): GoogleClient {
  const { db, now, config, secretKey } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function markReauth(): never {
    if (!getState(db).degraded.includes(REAUTH)) {
      addDegraded(db, REAUTH);
      emitEvent(
        db,
        { type: 'google.reauth', importance: 'normal', title: 'Autorisation Google à renouveler' },
        now(),
      );
    }
    throw new GoogleReauthError();
  }

  async function refresh(tokens: Tokens): Promise<string> {
    const res = await opts.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
    };
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) markReauth();
      throw new GoogleApiError(res.status, body.error ?? 'refresh failed');
    }
    saveTokens(db, secretKey, {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? tokens.refreshToken,
      expiresAt: new Date(now().getTime() + (body.expires_in ?? 3600) * 1000).toISOString(),
    });
    return body.access_token;
  }

  async function accessToken(force: boolean): Promise<string> {
    const tokens = loadTokens(db, secretKey);
    if (!tokens) throw new GoogleNotConnectedError();
    if (getState(db).degraded.includes(REAUTH)) markReauth();
    if (force || new Date(tokens.expiresAt).getTime() - EXPIRY_MARGIN_MS <= now().getTime()) {
      return refresh(tokens);
    }
    return tokens.accessToken;
  }

  return {
    async request<T>(method: string, url: string, body?: unknown): Promise<T> {
      let token = await accessToken(false);
      let refreshed = false;
      for (let attempt = 0; ; attempt++) {
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        const init: RequestInit = { method, headers };
        if (body !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        const res = await opts.fetch(url, init);
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          token = await accessToken(true);
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const text = await res.text();
        if (!res.ok) {
          let message = text;
          try {
            message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
          } catch {
            // keep the raw text
          }
          throw new GoogleApiError(res.status, message);
        }
        return (text ? JSON.parse(text) : undefined) as T;
      }
    },
  };
}
