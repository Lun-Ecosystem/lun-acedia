import { randomBytes } from 'node:crypto';
import { createRule } from '../triage/rules.ts';
import { describe, expect, it } from 'vitest';
import { fakeFetch, on } from '../testing/fake-fetch.ts';
import { makeHarness } from '../testing/harness.ts';
import { loadTokens, saveTokens, TOKEN_URL } from './client.ts';
import { authUrl, googleFromEnv, SCOPES } from './oauth.ts';

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

  it('sends a callback with an unknown state back to the settings, expired', async () => {
    const { h } = harness();
    const res = await h.app.request('/oauth/callback?code=abc&state=forged');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?google=expired');
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

  it('accepts a state only once: a replay is expired', async () => {
    const { h } = harness();
    const token = await h.pairClient();
    const { url } = await (await h.app.request('/api/google/auth-url', { headers: h.auth(token) })).json();
    const state = new URL(url).searchParams.get('state')!;
    await h.app.request(`/oauth/callback?code=abc&state=${state}`);
    const replay = await h.app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe('/?google=expired');
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

type Step = { status?: number; json?: unknown; text?: string; throws?: boolean };

/** A Google whose exchange and profile answer what the test sets; the n-th exchange hands out `acc`, `acc-2`… */
function scripted() {
  const script: { exchange?: Step; profile?: Step; email: string } = { email: 'test@example.com' };
  let n = 0;
  const reply = (step: Step) => {
    if (step.throws) throw new Error('réseau coupé');
    return step;
  };
  const fake = fakeFetch(
    (call) => {
      if (call.method !== 'POST' || call.url !== TOKEN_URL) return undefined;
      n += 1;
      return reply(
        script.exchange ?? {
          json: { access_token: n === 1 ? 'acc' : `acc-${n}`, refresh_token: `ref-${n}`, expires_in: 3600 },
        },
      );
    },
    (call) =>
      call.method === 'GET' && call.url === PROFILE
        ? reply(script.profile ?? { json: { emailAddress: script.email } })
        : undefined,
    on('POST', 'https://oauth2.googleapis.com/revoke', { json: {} }),
  );
  const h = makeHarness({ google: { config, secretKey, fetch: fake.fetch } });
  /** A paired client asks for a consent URL; the callback is then hit with `query(state)`. */
  async function back(query: (state: string) => string, existing?: string) {
    const token = existing ?? (await h.pairClient());
    const { url } = await (await h.app.request('/api/google/auth-url', { headers: h.auth(token) })).json();
    const state = new URL(url).searchParams.get('state')!;
    const res = await h.app.request(`/oauth/callback?${query(state)}`);
    return { res, token, state };
  }
  const code = (state: string) => `code=abc&state=${state}`;
  const status = async (token: string) =>
    (await h.app.request('/api/google/status', { headers: h.auth(token) })).json();
  /** A first account connected, with a rule that a change of account would erase. */
  async function connected() {
    const { token } = await back(code);
    h.db.prepare("INSERT INTO labels (id, name, type) VALUES ('Label_3', 'École', 'user')").run();
    h.db.prepare("INSERT INTO label_roles (label_id, role) VALUES ('Label_3', 'box')").run();
    createRule(h.db, { field: 'fromDomain', op: 'equals', value: 'ecole.fr', boxId: 'Label_3' });
    return token;
  }
  return { h, script, calls: fake.calls, back, code, status, connected };
}

const ADDRESSES = ['refused', 'failed', 'expired', 'connected'].map((c) => `/?google=${c}`);
const exchanged = (calls: { url: string }[]) => calls.some((c) => c.url === TOKEN_URL);

describe('Google return', () => {
  it('sends a refusal back to the settings; the same state replayed is expired', async () => {
    const s = scripted();
    const { res, state } = await s.back((st) => `error=access_denied&state=${st}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?google=refused');
    expect(exchanged(s.calls)).toBe(false);
    const replay = await s.h.app.request(`/oauth/callback?error=access_denied&state=${state}`);
    expect(replay.headers.get('location')).toBe('/?google=expired');
  });

  describe.each([['code=abc'], ['error=access_denied']])('a state that is not fresh, with %s', (extra) => {
    it('unknown: expired', async () => {
      const s = scripted();
      const res = await s.h.app.request(`/oauth/callback?${extra}&state=forged`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?google=expired');
    });

    it('already served: expired', async () => {
      const s = scripted();
      const { state } = await s.back(s.code);
      const res = await s.h.app.request(`/oauth/callback?${extra}&state=${state}`);
      expect(res.headers.get('location')).toBe('/?google=expired');
    });

    it('older than ten minutes: expired, and Google is not called', async () => {
      const s = scripted();
      const { res } = await (async () => {
        const token = await s.h.pairClient();
        const { url } = await (
          await s.h.app.request('/api/google/auth-url', { headers: s.h.auth(token) })
        ).json();
        s.h.advance(10 * 60_000 + 1000);
        const state = new URL(url).searchParams.get('state')!;
        return { res: await s.h.app.request(`/oauth/callback?${extra}&state=${state}`) };
      })();
      expect(res.headers.get('location')).toBe('/?google=expired');
      expect(exchanged(s.calls)).toBe(false);
    });
  });

  it.each([
    ['another error', (st: string) => `error=invalid_scope&state=${st}`],
    ['neither code nor error', (st: string) => `state=${st}`],
  ])('a fresh state with %s: failed, Google is not called', async (_name, query) => {
    const s = scripted();
    const { res } = await s.back(query);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?google=failed');
    expect(exchanged(s.calls)).toBe(false);
  });

  it('copies nothing Google sends: one of four fixed addresses, no markup in the body', async () => {
    const s = scripted();
    const tail = 'error=<b>x</b>&error_description=<b>y</b>';
    const fresh = (await s.back((st) => `${tail}&state=${st}`)).res;
    const stale = await s.h.app.request(`/oauth/callback?${tail}&state=old`);
    for (const res of [fresh, stale]) {
      expect(ADDRESSES).toContain(res.headers.get('location'));
      expect(await res.text()).not.toMatch(/<b>|<\/b>/);
    }
  });

  describe('a failure leaves the connected account as it was', () => {
    const failures: [string, Partial<Pick<ReturnType<typeof scripted>['script'], 'exchange' | 'profile'>>][] =
      [
        ['an exchange refused (400)', { exchange: { status: 400, json: { error: 'invalid_grant' } } }],
        [
          'an exchange without refresh_token',
          { exchange: { json: { access_token: 'acc-2', expires_in: 3600 } } },
        ],
        ['an exchange that is not JSON', { exchange: { text: '<html>oups</html>' } }],
        ['an exchange that throws', { exchange: { throws: true } }],
        ['a profile refused (403)', { profile: { status: 403, json: { error: { message: 'API off' } } } }],
        ['a profile without address ({})', { profile: { json: {} } }],
        ['a profile with an empty address', { profile: { json: { emailAddress: '' } } }],
        ['a profile that is not JSON', { profile: { text: 'pas du json' } }],
      ];

    it.each(failures)('%s: failed; tokens, address and rules unchanged', async (_name, failure) => {
      const s = scripted();
      const token = await s.connected();
      const before = JSON.stringify(s.h.db.prepare('SELECT * FROM google_tokens').all());
      Object.assign(s.script, failure, { email: 'autre@example.com' });
      const { res } = await s.back(s.code, token);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?google=failed');
      expect(loadTokens(s.h.db, secretKey)?.accessToken).toBe('acc');
      expect(JSON.stringify(s.h.db.prepare('SELECT * FROM google_tokens').all())).toBe(before);
      expect(await s.status(token)).toEqual({ connected: true, email: 'test@example.com' });
      expect(count(s.h, 'rules')).toBe(1);
    });
  });

  it('reads the profile with the token of this exchange, not the one stored before', async () => {
    const s = scripted();
    const token = await s.connected();
    s.script.email = 'autre@example.com';
    const { res } = await s.back(s.code, token);
    expect(res.headers.get('location')).toBe('/?google=connected');
    expect(s.calls.filter((c) => c.url === PROFILE).at(-1)!.headers.authorization).toBe('Bearer acc-2');
  });
});

describe('an unreadable token', () => {
  type H = ReturnType<typeof scripted>['h'];
  const spoil: Record<string, (h: H) => unknown> = {
    'another key': (h) =>
      saveTokens(h.db, randomBytes(32).toString('base64'), {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    'a damaged text': (h) => h.db.prepare("UPDATE google_tokens SET access_token = 'x.y.z'").run(),
  };

  it.each(Object.keys(spoil))(
    'stored with %s: the status is not connected and unreadable, no 500',
    async (how) => {
      const s = scripted();
      const token = await s.connected();
      spoil[how]!(s.h);
      const res = await s.h.app.request('/api/google/status', { headers: s.h.auth(token) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connected: false, unreadable: true });
    },
  );

  it('with no row at all, the status stays { connected: false }, without unreadable', async () => {
    const s = scripted();
    const token = await s.h.pairClient();
    expect(await s.status(token)).toStrictEqual({ connected: false });
  });

  it('disconnects (200) without calling Google; a reconnection works and keeps the rules', async () => {
    const s = scripted();
    const token = await s.connected();
    spoil['another key']!(s.h);
    const res = await s.h.app.request('/api/google/disconnect', { method: 'POST', headers: s.h.auth(token) });
    expect(res.status).toBe(200);
    expect(count(s.h, 'google_tokens')).toBe(0);
    expect(s.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(false);
    const again = await s.back(s.code, token);
    expect(again.res.headers.get('location')).toBe('/?google=connected');
    expect(await s.status(token)).toEqual({ connected: true, email: 'test@example.com' });
    expect(count(s.h, 'rules')).toBe(1);
  });
});

describe('googleFromEnv', () => {
  it('takes PORT and GOOGLE_REDIRECT_URI set but empty for absent ones: the default return address', () => {
    const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', ACEDIA_SECRET_KEY: secretKey };
    expect(googleFromEnv({ ...env, PORT: '', GOOGLE_REDIRECT_URI: ' ' })?.config.redirectUri).toBe(
      'http://localhost:8787/oauth/callback',
    );
    expect(googleFromEnv({ ...env, PORT: '8080' })?.config.redirectUri).toBe(
      'http://localhost:8080/oauth/callback',
    );
  });

  it.each([
    ['16 bytes', randomBytes(16).toString('base64')],
    ['48 bytes', randomBytes(48).toString('base64')],
    ['not base64', '%%%%'],
  ])('a malformed ACEDIA_SECRET_KEY (%s): Google is not configured', (_name, key) => {
    const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', ACEDIA_SECRET_KEY: key };
    expect(googleFromEnv(env)).toBeUndefined();
  });
});
