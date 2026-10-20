import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getState } from '../contract/state.ts';
import { eventsSince } from '../contract/events.ts';
import { openDb } from '../db.ts';
import { fakeFetch, on, sequence } from '../testing/fake-fetch.ts';
import { createGoogleClient, GoogleReauthError, saveTokens, TOKEN_URL } from './client.ts';

const secretKey = randomBytes(32).toString('base64');
const config = {
  clientId: 'id',
  clientSecret: 'secret',
  redirectUri: 'http://localhost:8787/oauth/callback',
};
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

function setup(expiresInMs: number, ...handlers: Parameters<typeof fakeFetch>) {
  const db = openDb(':memory:');
  const now = new Date('2026-11-02T08:00:00.000Z');
  saveTokens(db, secretKey, {
    accessToken: 'old-access',
    refreshToken: 'refresh-1',
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
  });
  const fake = fakeFetch(...handlers);
  const client = createGoogleClient({
    db,
    fetch: fake.fetch,
    now: () => now,
    config,
    secretKey,
    sleep: async () => {},
  });
  return { db, client, calls: fake.calls };
}

const refreshOk = on('POST', TOKEN_URL, { json: { access_token: 'new-access', expires_in: 3600 } });

describe('Google client', () => {
  it('refreshes an expired token before the call', async () => {
    const { client, calls } = setup(-1000, refreshOk, on('GET', API, { json: { emailAddress: 'x' } }));
    await client.request('GET', API);
    expect(calls.map((c) => c.method + ' ' + c.url)).toEqual([`POST ${TOKEN_URL}`, `GET ${API}`]);
    expect(calls[1]!.headers.authorization).toBe('Bearer new-access');
  });

  it('uses a valid token without refreshing', async () => {
    const { client, calls } = setup(3600_000, on('GET', API, { json: {} }));
    await client.request('GET', API);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe('Bearer old-access');
  });

  it('refreshes once on a 401 and retries', async () => {
    const { client, calls } = setup(
      3600_000,
      refreshOk,
      sequence('GET', API, [{ status: 401, json: {} }, { json: { ok: 1 } }]),
    );
    expect(await client.request('GET', API)).toEqual({ ok: 1 });
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('retries on 429 and 5xx, three times at most', async () => {
    const { client, calls } = setup(
      3600_000,
      sequence('GET', API, [{ status: 429 }, { status: 503 }, { json: { ok: 1 } }]),
    );
    expect(await client.request('GET', API)).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });

  it('gives up after three retries', async () => {
    const { client } = setup(3600_000, on('GET', API, { status: 500, json: { error: { message: 'boom' } } }));
    await expect(client.request('GET', API)).rejects.toThrow(/500/);
  });

  it('sends a JSON body', async () => {
    const { client, calls } = setup(3600_000, on('POST', API, { json: {} }));
    await client.request('POST', API, { a: 1 });
    expect(calls[0]!.body).toBe('{"a":1}');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('marks the satellite degraded and emits one event when the refresh is refused', async () => {
    const { db, client } = setup(
      -1000,
      on('POST', TOKEN_URL, { status: 400, json: { error: 'invalid_grant' } }),
    );
    for (let i = 0; i < 10; i++)
      await expect(client.request('GET', API)).rejects.toBeInstanceOf(GoogleReauthError);
    expect(getState(db).degraded).toEqual(['google-reauth']);
    const events = eventsSince(db).filter((e) => e.type === 'google.reauth');
    expect(events).toHaveLength(1);
    expect(events[0]!.importance).toBe('urgent');
  });

  it('clears the degraded state once tokens are saved again', async () => {
    const { db, client } = setup(
      -1000,
      on('POST', TOKEN_URL, { status: 400, json: { error: 'invalid_grant' } }),
    );
    await expect(client.request('GET', API)).rejects.toBeInstanceOf(GoogleReauthError);
    saveTokens(db, secretKey, { accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(getState(db).degraded).toEqual([]);
  });
});
