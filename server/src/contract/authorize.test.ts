import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeHarness } from '../testing/harness.ts';
import { isLoopbackRedirect } from './authorize.ts';

const json = { 'content-type': 'application/json' };
const VERIFIER = 'a-verifier-of-enough-length-for-pkce-0123456789';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://127.0.0.1:43123/callback';

type Harness = ReturnType<typeof makeHarness>;

function authorizeUrl(params: Record<string, string>): string {
  return `/lun/v1/authorize?${new URLSearchParams(params).toString()}`;
}

async function decide(h: Harness, token: string, decision: 'allow' | 'deny', redirect = REDIRECT) {
  return h.app.request('/api/authorizations', {
    method: 'POST',
    headers: h.auth(token),
    body: JSON.stringify({
      client: "Lun'Anima",
      redirect_uri: redirect,
      state: 'st4te',
      code_challenge: CHALLENGE,
      decision,
    }),
  });
}

async function allowCode(h: Harness, token: string): Promise<string> {
  const res = await decide(h, token, 'allow');
  const { redirect } = (await res.json()) as { redirect: string };
  return new URL(redirect).searchParams.get('code')!;
}

function exchange(h: Harness, code: string, verifier = VERIFIER) {
  return h.app.request('/lun/v1/pair', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ code, code_verifier: verifier, client: 'ignored' }),
  });
}

function failures(h: Harness): number {
  return (h.db.prepare('SELECT COUNT(*) AS n FROM pairing_failures').get() as { n: number }).n;
}

describe('isLoopbackRedirect', () => {
  it('rejects tricky redirect_uri', () => {
    for (const uri of [
      'http://localhost.evil.test/',
      'http://127.0.0.1@evil.test/',
      'https://localhost/',
      'javascript:alert(1)',
      'http://user:pass@127.0.0.1/',
      'http://127.0.0.2/',
      'not a url',
    ])
      expect(isLoopbackRedirect(uri), uri).toBe(false);
    for (const uri of ['http://127.0.0.1:43123/callback', 'http://localhost:8080/', 'http://localhost/x?y=1'])
      expect(isLoopbackRedirect(uri), uri).toBe(true);
  });
});

describe('GET /lun/v1/authorize', () => {
  const valid = { client: "Lun'Anima", redirect_uri: REDIRECT, state: 'st4te', code_challenge: CHALLENGE };

  it('redirects a valid request to the front', async () => {
    const h = makeHarness();
    const res = await h.app.request(authorizeUrl(valid));
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get('location')!, 'http://satellite.test');
    expect(target.pathname).toBe('/');
    expect(Object.fromEntries(target.searchParams)).toEqual({ autoriser: '1', ...valid });
  });

  it('answers 400 in plain text, without redirecting, on a bad request', async () => {
    const h = makeHarness();
    for (const params of [
      { ...valid, redirect_uri: 'http://localhost.evil.test/' },
      { client: valid.client, redirect_uri: REDIRECT, state: 'st4te' },
    ]) {
      const res = await h.app.request(authorizeUrl(params));
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });
});

describe('POST /api/authorizations', () => {
  it('issues a code only to a device token', async () => {
    const h = makeHarness();
    const device = await h.pairClient('phone');
    const res = await exchange(h, await allowCode(h, device));
    const { token: appToken } = (await res.json()) as { token: string };
    expect((await decide(h, appToken, 'allow')).status).toBe(403);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM authorization_codes').get()).toEqual({ n: 1 });
  });

  it('revalidates redirect_uri', async () => {
    const h = makeHarness();
    const device = await h.pairClient('phone');
    expect((await decide(h, device, 'allow', 'http://127.0.0.1@evil.test/')).status).toBe(400);
    expect((await decide(h, device, 'deny', 'https://localhost/')).status).toBe(400);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM authorization_codes').get()).toEqual({ n: 0 });
  });

  it('allow then pair with the right verifier creates one app client', async () => {
    const h = makeHarness();
    const device = await h.pairClient('phone');
    const res = await decide(h, device, 'allow');
    expect(res.status).toBe(200);
    const redirect = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('st4te');
    const code = redirect.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const paired = await exchange(h, code);
    expect(paired.status).toBe(200);
    const body = await paired.json();
    expect(body.token).toMatch(/.{32,}/);
    expect(body.satellite).toEqual({ id: 'lunacedia', nom: "Lun'Acedia", version: '0.0.0-test' });
    expect(h.db.prepare('SELECT name, kind FROM clients ORDER BY id').all()).toEqual([
      { name: 'phone', kind: 'device' },
      { name: "Lun'Anima", kind: 'app' },
    ]);
    const health = await h.app.request('/lun/v1/health', { headers: h.auth(body.token) });
    expect(health.status).toBe(200);
  });

  it('wrong verifier, expired code (2 min 1 s), reused code: 401, counted as failures', async () => {
    const h = makeHarness();
    const device = await h.pairClient('phone');

    const wrong = await allowCode(h, device);
    expect((await exchange(h, wrong, 'another-verifier-of-enough-length-0123456789')).status).toBe(401);
    expect(failures(h)).toBe(1);

    const expired = await allowCode(h, device);
    h.advance(2 * 60_000 + 1_000);
    expect((await exchange(h, expired)).status).toBe(401);
    expect(failures(h)).toBe(2);

    const reused = await allowCode(h, device);
    expect((await exchange(h, reused)).status).toBe(200);
    const again = await exchange(h, reused);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: expect.any(String) });
    expect(failures(h)).toBe(3);

    expect((await exchange(h, 'unknown-code')).status).toBe(401);
    expect(failures(h)).toBe(4);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM clients WHERE kind = 'app'").get()).toEqual({ n: 1 });
  });

  it('deny returns error=access_denied and creates nothing', async () => {
    const h = makeHarness();
    const device = await h.pairClient('phone');
    const res = await decide(h, device, 'deny');
    expect(res.status).toBe(200);
    const redirect = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(Object.fromEntries(redirect.searchParams)).toEqual({ error: 'access_denied', state: 'st4te' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM authorization_codes').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM clients').get()).toEqual({ n: 1 });
    expect(failures(h)).toBe(0);
  });

  it('the lock also voids pending authorization codes', async () => {
    const h = makeHarness();
    const device = await h.pairClient('phone');
    const pending = await allowCode(h, device);
    for (let i = 0; i < 5; i++)
      await h.app.request('/lun/v1/pair', { method: 'POST', headers: json, body: '{"code":"000000"}' });
    expect(h.logs).toContain('Appairage verrouillé : 5 codes faux en 10 min, codes en cours annulés.');
    expect((await exchange(h, pending)).status).toBe(401);
    // Codes asked afterwards work normally.
    expect((await exchange(h, await allowCode(h, device))).status).toBe(200);
  });
});
