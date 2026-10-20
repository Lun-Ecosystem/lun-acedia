import { randomBytes } from 'node:crypto';
import { createRule } from '../triage/rules.ts';
import { describe, expect, it } from 'vitest';
import { fakeFetch, on } from '../testing/fake-fetch.ts';
import { makeHarness } from '../testing/harness.ts';
import { TOKEN_URL } from './client.ts';
import { authUrl, SCOPES } from './oauth.ts';

const secretKey = randomBytes(32).toString('base64');
const config = {
  clientId: 'client-id',
  clientSecret: 'secret',
  redirectUri: 'http://localhost:8787/oauth/callback',
};
const PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

function harness() {
  const account = { email: 'test@example.com' };
  const fake = fakeFetch(
    on('POST', TOKEN_URL, { json: { access_token: 'acc', refresh_token: 'ref-secret', expires_in: 3600 } }),
    (call) =>
      call.method === 'GET' && call.url === PROFILE ? { json: { emailAddress: account.email } } : undefined,
    on('POST', 'https://oauth2.googleapis.com/revoke', { json: {} }),
  );
  const h = makeHarness({ google: { config, secretKey, fetch: fake.fetch } });
  async function connect(email: string) {
    account.email = email;
    const token = await h.pairClient();
    const { url } = await (await h.app.request('/api/google/auth-url', { headers: h.auth(token) })).json();
    await h.app.request(`/oauth/callback?code=abc&state=${new URL(url).searchParams.get('state')}`);
    return token;
  }
  return { h, calls: fake.calls, connect };
}

const count = (h: ReturnType<typeof makeHarness>, table: string) =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('Google authorization', () => {
  it('builds a consent URL asking for offline access and the five scopes', () => {
    const url = new URL(authUrl(config, 'st4te'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(SCOPES);
    expect(SCOPES).toHaveLength(5);
  });

  it('hands out a consent URL to a paired client', async () => {
    const { h } = harness();
    const token = await h.pairClient();
    const res = await h.app.request('/api/google/auth-url', { headers: h.auth(token) });
    const { url } = await res.json();
    expect(new URL(url).searchParams.get('state')).toMatch(/.{16,}/);
  });

  it('refuses a callback with an unknown state', async () => {
    const { h } = harness();
    const res = await h.app.request('/oauth/callback?code=abc&state=forged');
    expect(res.status).toBe(400);
  });

  it('stores the tokens encrypted and reports the connected account', async () => {
    const { h } = harness();
    const token = await h.pairClient();
    const { url } = await (await h.app.request('/api/google/auth-url', { headers: h.auth(token) })).json();
    const state = new URL(url).searchParams.get('state')!;
    const res = await h.app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?google=connected');
    const rows = JSON.stringify(h.db.prepare('SELECT * FROM google_tokens').all());
    expect(rows).not.toContain('ref-secret');
    const status = await (await h.app.request('/api/google/status', { headers: h.auth(token) })).json();
    expect(status).toEqual({ connected: true, email: 'test@example.com' });
  });

  it('accepts a state only once', async () => {
    const { h } = harness();
    const token = await h.pairClient();
    const { url } = await (await h.app.request('/api/google/auth-url', { headers: h.auth(token) })).json();
    const state = new URL(url).searchParams.get('state')!;
    await h.app.request(`/oauth/callback?code=abc&state=${state}`);
    const replay = await h.app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(replay.status).toBe(400);
  });

  it('disconnects: revokes at Google and forgets the tokens', async () => {
    const { h, calls } = harness();
    const token = await h.pairClient();
    const { url } = await (await h.app.request('/api/google/auth-url', { headers: h.auth(token) })).json();
    await h.app.request(`/oauth/callback?code=abc&state=${new URL(url).searchParams.get('state')}`);
    const res = await h.app.request('/api/google/disconnect', { method: 'POST', headers: h.auth(token) });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(true);
    const status = await (await h.app.request('/api/google/status', { headers: h.auth(token) })).json();
    expect(status).toEqual({ connected: false });
  });

  it('reports not connected when Google is not configured', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const status = await (await h.app.request('/api/google/status', { headers: h.auth(token) })).json();
    expect(status).toEqual({ connected: false });
  });

  it('starts afresh when another Google account is connected', async () => {
    const { h, connect } = harness();
    const token = await connect('test@example.com');
    h.db.prepare("INSERT INTO labels (id, name, type) VALUES ('Label_3', 'École', 'user')").run();
    h.db.prepare("INSERT INTO label_roles (label_id, role) VALUES ('Label_3', 'box')").run();
    createRule(h.db, { field: 'fromDomain', op: 'equals', value: 'ecole.fr', boxId: 'Label_3' });
    h.db.prepare("INSERT INTO sync_state (key, value) VALUES ('gmail.historyId', '42')").run();
    await h.app.request('/api/google/disconnect', { method: 'POST', headers: h.auth(token) });
    await connect('test@example.com');
    expect(count(h, 'rules')).toBe(1);
    await connect('autre@example.com');
    for (const table of ['rules', 'labels', 'label_roles', 'sync_state']) expect(count(h, table)).toBe(0);
  });
});
