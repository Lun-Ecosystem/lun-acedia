import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { addDegraded, getState } from '../contract/state.ts';
import { getSetting } from '../db.ts';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { makeHarness } from '../testing/harness.ts';
import type { Classifier } from '../triage/classifier.ts';
import { getProposal, triageNew } from '../triage/pipeline.ts';
import { classifierFor, currentAnthropicKey, keyRefused, saveAnthropicKey } from './anthropic-key.ts';

const NEW_KEY = 'sk-ant-test-new-abcd1234';
const ENV_KEY = 'sk-ant-test-env-wxyz9876';

async function client(h: ReturnType<typeof makeHarness>) {
  const token = await h.pairClient();
  return async (method: string, body?: unknown) => {
    const init: RequestInit = { method, headers: h.auth(token) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await h.app.request('/api/anthropic-key', init);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
}

describe('Anthropic key', () => {
  it('PUT verifies, saves encrypted, never returns the key, the next mail uses it', async () => {
    const h = await makeGmailHarness();
    keyRefused(h.db, h.clock());
    const res = await h.call('PUT', '/api/anthropic-key', { key: NEW_KEY, expires: '2026-12-01' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'ok', last4: '1234', expires: '2026-12-01', source: 'saved' });
    expect(JSON.stringify(res.body)).not.toContain(NEW_KEY);
    expect(h.anthropicCheck.calls).toEqual([NEW_KEY]);
    // Encrypted at rest.
    const raw = h.db.prepare('SELECT value FROM settings WHERE key = ?').get('anthropic.key') as {
      value: string;
    };
    expect(raw.value).not.toContain('abcd1234');
    expect(currentAnthropicKey(h.db, h.secretKey, ENV_KEY)).toEqual({ key: NEW_KEY, source: 'saved' });
    // The key works: the refused state is lifted.
    expect(getState(h.db).degraded).toEqual([]);
    expect(eventsSince(h.db).map((e) => e.type)).toContain('key.restored');

    // The next triage pass builds its classifier from the saved key, without a restart.
    const used: string[] = [];
    const make = (apiKey: string): Classifier => {
      used.push(apiKey);
      return {
        model: 'claude-haiku-5-5',
        classify: async () => ({
          boxId: null,
          tagIds: [],
          importance: 'normal',
          confidence: 50,
          reason: 'Test.',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      };
    };
    h.gmail.deliver(message({ id: 'n1', date: '2026-11-02T08:30:00.000Z' }));
    const ids = (await h.sync()).added;
    await triageNew({ ...h.deps, classifier: classifierFor(h.db, h.secretKey, ENV_KEY, make) }, ids);
    expect(used).toEqual([NEW_KEY]);
    expect(getProposal(h.db, 'n1')?.status).toBe('pending');
  });

  it('a refused or unreachable check changes nothing', async () => {
    const secretKey = randomBytes(32).toString('base64');
    const h = makeHarness({ secretKey });
    const call = await client(h);
    saveAnthropicKey(h.db, secretKey, 'sk-ant-test-old-0000', '2026-12-24');
    const before = await call('GET');
    expect(before.body).toEqual({ state: 'ok', last4: '0000', expires: '2026-12-24', source: 'saved' });

    h.anthropicCheck.result = 'refused';
    const refused = await call('PUT', { key: NEW_KEY, expires: '2027-01-01' });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'Clé refusée par Anthropic, rien n’a changé' });

    h.anthropicCheck.result = 'unreachable';
    const unreachable = await call('PUT', { key: NEW_KEY });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body).toEqual({ error: 'Anthropic injoignable, rien n’a changé' });

    expect((await call('GET')).body).toEqual(before.body);
    expect(currentAnthropicKey(h.db, secretKey)?.key).toBe('sk-ant-test-old-0000');
    expect(getSetting(h.db, 'anthropic.expires', undefined)).toBe('2026-12-24');
  });

  it('PUT refuses without ACEDIA_SECRET_KEY, without a key, or with an invalid date', async () => {
    const h = makeHarness();
    const call = await client(h);
    const noSecret = await call('PUT', { key: NEW_KEY });
    expect(noSecret.status).toBe(400);
    expect(noSecret.body.error).toContain('ACEDIA_SECRET_KEY');
    expect(h.anthropicCheck.calls).toEqual([]);

    const h2 = makeHarness({ secretKey: randomBytes(32).toString('base64') });
    const call2 = await client(h2);
    expect((await call2('PUT', {})).status).toBe(400);
    expect((await call2('PUT', { key: '   ' })).status).toBe(400);
    expect((await call2('PUT', { key: NEW_KEY, expires: '01/12/2026' })).status).toBe(400);
    expect((await call2('PUT', { key: NEW_KEY, expires: '2026-02-30' })).status).toBe(400);
    expect(h2.anthropicCheck.calls).toEqual([]);
  });

  it('a new key resets the expiry warnings', async () => {
    const secretKey = randomBytes(32).toString('base64');
    const h = makeHarness({ secretKey });
    const call = await client(h);
    // Declared 10 days ahead: the J-14 warning leaves at once.
    await call('PUT', { key: 'sk-ant-test-one-1111', expires: '2026-11-12' });
    expect(getSetting(h.db, 'anthropic.expiryWarned', [] as number[])).toEqual([14]);
    await call('PUT', { key: 'sk-ant-test-two-2222', expires: '2026-11-12' });
    const expiring = eventsSince(h.db).filter((e) => e.type === 'key.expiring');
    expect(expiring.map((e) => e.data)).toEqual([
      { daysLeft: 14, expires: '2026-11-12' },
      { daysLeft: 14, expires: '2026-11-12' },
    ]);
  });

  it('DELETE removes the saved key; the .env key, if any, takes over', async () => {
    const secretKey = randomBytes(32).toString('base64');
    const h = makeHarness({ secretKey });
    const call = await client(h);
    saveAnthropicKey(h.db, secretKey, 'sk-ant-test-old-0000', '2026-12-24');
    keyRefused(h.db, h.clock());
    const removed = await call('DELETE');
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ state: 'absent' });
    expect(getSetting(h.db, 'anthropic.expires', undefined)).toBeNull();
    // Nothing is refused any more: the AI simply has no key.
    expect(getState(h.db).degraded).toEqual([]);

    const h2 = makeHarness({ secretKey, anthropicEnv: { key: ENV_KEY } });
    const call2 = await client(h2);
    saveAnthropicKey(h2.db, secretKey, 'sk-ant-test-old-0000');
    expect((await call2('DELETE')).body).toEqual({ state: 'ok', last4: '9876', source: 'env' });
  });

  it('DELETE without any key answers absent and changes nothing', async () => {
    const h = makeHarness({ secretKey: randomBytes(32).toString('base64') });
    const call = await client(h);
    const res = await call('DELETE');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'absent' });
    expect(eventsSince(h.db)).toEqual([]);
  });

  it('GET never contains the key', async () => {
    const absent = makeHarness();
    expect((await (await client(absent))('GET')).body).toEqual({ state: 'absent' });

    const h = makeHarness({ anthropicEnv: { key: ENV_KEY, expires: '2026-12-24' } });
    const call = await client(h);
    const ok = await call('GET');
    expect(ok.body).toEqual({ state: 'ok', last4: '9876', expires: '2026-12-24', source: 'env' });
    expect(ok.text).not.toContain(ENV_KEY);

    addDegraded(h.db, 'credit');
    expect((await call('GET')).body.state).toBe('credit');
    keyRefused(h.db, h.clock());
    const refused = await call('GET');
    expect(refused.body.state).toBe('refused');
    expect(refused.text).not.toContain(ENV_KEY);
  });
});
