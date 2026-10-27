import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { addDegraded, getState } from '../contract/state.ts';
import { encrypt } from '../crypto.ts';
import { getSetting, openDb, putSetting } from '../db.ts';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { makeHarness } from '../testing/harness.ts';
import { getProposal, triageNew } from '../triage/pipeline.ts';
import {
  checkKeyExpiries,
  classifierFor,
  configuredProviders,
  currentKey,
  keyRefused,
  keyWorks,
  providerFor,
  providersView,
  saveKey,
  type ProviderFactory,
} from './keys.ts';
import type { LlmProvider, ProviderId } from './types.ts';

const NEW_KEY = 'sk-ant-test-new-abcd1234';
const ENV_KEY = 'sk-ant-test-env-wxyz9876';

/** A provider factory that never reaches the network: records what it built and the models asked. */
function fakeFactory() {
  const built: { id: ProviderId; apiKey: string; baseUrl?: string | undefined }[] = [];
  const models: string[] = [];
  const make: ProviderFactory = (id, apiKey, baseUrl) => {
    built.push({ id, apiKey, baseUrl });
    const provider: LlmProvider = {
      id,
      json: async (req) => {
        models.push(req.model);
        return {
          value: { boxId: 'none', tagIds: [], importance: 'normal', confidence: 50, reason: 'Test.' },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      chat: async () => {
        throw new Error('not used');
      },
      check: async () => 'ok',
    };
    return provider;
  };
  return { make, built, models };
}

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

describe('keys per provider', () => {
  it('saved anthropic.* settings are read as the anthropic provider (no re-entry)', () => {
    const secretKey = randomBytes(32).toString('base64');
    const db = openDb(':memory:');
    // Exactly what the single-provider module wrote before.
    putSetting(db, 'anthropic.key', encrypt('sk-ant-test-old-0000', secretKey));
    putSetting(db, 'anthropic.expires', '2026-12-24');
    expect(configuredProviders(db, secretKey, {})).toEqual(['anthropic']);
    expect(providersView(db, secretKey, {}).find((p) => p.id === 'anthropic')).toEqual({
      id: 'anthropic',
      label: 'Anthropic',
      state: 'ok',
      last4: '0000',
      expires: '2026-12-24',
      source: 'saved',
    });
    const { make, built } = fakeFactory();
    expect(providerFor(db, secretKey, {}, 'anthropic', make)?.id).toBe('anthropic');
    expect(built).toEqual([{ id: 'anthropic', apiKey: 'sk-ant-test-old-0000', baseUrl: undefined }]);
    expect(providerFor(db, secretKey, {}, 'openai', make)).toBeUndefined();
  });

  it('a refused key emits key.invalid naming the provider once, restored emits key.restored', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-11-02T08:00:00.000Z');
    keyRefused(db, 'openai', now);
    keyRefused(db, 'openai', now);
    expect(getState(db).degraded).toEqual(['openai-key']);
    expect(getSetting(db, 'openai.keyState', 'ok')).toBe('refused');
    keyWorks(db, 'openai', now);
    keyWorks(db, 'openai', now);
    expect(getState(db).degraded).toEqual([]);
    const events = eventsSince(db).filter((e) => e.type.startsWith('key.'));
    expect(events).toMatchObject([
      {
        type: 'key.invalid',
        importance: 'normal',
        title: 'Clé OpenAI refusée : le tri par l’IA est en pause, les règles continuent',
        data: { provider: 'openai' },
      },
      { type: 'key.restored', importance: 'info', title: 'Clé OpenAI de nouveau en service' },
    ]);
    // Another provider keeps its own state.
    expect(getSetting(db, 'anthropic.keyState', 'ok')).toBe('ok');
  });

  it('triage uses llm.triage provider and model', async () => {
    const secretKey = randomBytes(32).toString('base64');
    const db = openDb(':memory:');
    const { make, built, models } = fakeFactory();
    const input = {
      mail: { from: '', to: '', subject: '', date: '', text: '' },
      boxes: [],
      tags: [],
      examples: [],
    };
    // Nothing chosen, an Anthropic key: today's behaviour, and nothing written.
    saveKey(db, secretKey, 'anthropic', NEW_KEY);
    saveKey(db, secretKey, 'openai', 'sk-test-openai-5678');
    const byDefault = classifierFor(db, secretKey, {}, make);
    expect([byDefault?.provider, byDefault?.model]).toEqual(['anthropic', 'claude-haiku-5-5']);
    expect(getSetting(db, 'llm.triage', null)).toBeNull();

    putSetting(db, 'llm.triage', { provider: 'openai', model: 'gpt-6-luna' });
    const chosen = classifierFor(db, secretKey, {}, make);
    expect([chosen?.provider, chosen?.model]).toEqual(['openai', 'gpt-6-luna']);
    await chosen!.classify(input);
    expect(models).toEqual(['gpt-6-luna']);
    expect(built.at(-1)).toMatchObject({ id: 'openai', apiKey: 'sk-test-openai-5678' });

    // Without any key, only the rules run.
    expect(classifierFor(openDb(':memory:'), secretKey, {}, make)).toBeUndefined();
  });

  it('expiry warnings run per configured provider', () => {
    const secretKey = randomBytes(32).toString('base64');
    const db = openDb(':memory:');
    const now = new Date('2026-11-02T08:00:00.000Z');
    saveKey(db, secretKey, 'anthropic', NEW_KEY, '2026-11-12');
    const env = { openai: { key: 'sk-test-openai-5678', expires: '2026-11-04' } };
    checkKeyExpiries(db, secretKey, env, now);
    checkKeyExpiries(db, secretKey, env, now);
    const expiring = eventsSince(db).filter((e) => e.type === 'key.expiring');
    expect(expiring.map((e) => [e.title, e.data])).toEqual([
      [
        'Clé Anthropic : échéance déclarée le 12/11/2026, dans 10 jours',
        { daysLeft: 14, expires: '2026-11-12' },
      ],
      ['Clé OpenAI : échéance déclarée le 04/11/2026, dans 2 jours', { daysLeft: 3, expires: '2026-11-04' }],
    ]);
    expect(getSetting(db, 'anthropic.expiryWarned', [])).toEqual([14]);
    expect(getSetting(db, 'openai.expiryWarned', [])).toEqual([14, 3]);
  });
});

describe('/api/anthropic-key (until the settings screen moves to /api/llm)', () => {
  it('PUT verifies, saves encrypted, never returns the key, the next mail uses it', async () => {
    const h = await makeGmailHarness();
    keyRefused(h.db, 'anthropic', h.clock());
    const res = await h.call('PUT', '/api/anthropic-key', { key: NEW_KEY, expires: '2026-12-01' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'ok', last4: '1234', expires: '2026-12-01', source: 'saved' });
    expect(JSON.stringify(res.body)).not.toContain(NEW_KEY);
    expect(h.keyCheck.calls).toEqual([{ id: 'anthropic', key: NEW_KEY }]);
    // Encrypted at rest.
    const raw = h.db.prepare('SELECT value FROM settings WHERE key = ?').get('anthropic.key') as {
      value: string;
    };
    expect(raw.value).not.toContain('abcd1234');
    const env = { anthropic: { key: ENV_KEY } };
    expect(currentKey(h.db, h.secretKey, env, 'anthropic')).toEqual({ key: NEW_KEY, source: 'saved' });
    // The key works: the refused state is lifted.
    expect(getState(h.db).degraded).toEqual([]);
    expect(eventsSince(h.db).map((e) => e.type)).toContain('key.restored');

    // The next triage pass builds its classifier from the saved key, without a restart.
    const { make, built } = fakeFactory();
    h.gmail.deliver(message({ id: 'n1', date: '2026-11-02T08:30:00.000Z' }));
    const ids = (await h.sync()).added;
    await triageNew({ ...h.deps, classifier: classifierFor(h.db, h.secretKey, env, make) }, ids);
    expect(built.map((b) => b.apiKey)).toEqual([NEW_KEY]);
    expect(getProposal(h.db, 'n1')?.status).toBe('pending');
  });

  it('a refused or unreachable check changes nothing', async () => {
    const secretKey = randomBytes(32).toString('base64');
    const h = makeHarness({ secretKey });
    const call = await client(h);
    saveKey(h.db, secretKey, 'anthropic', 'sk-ant-test-old-0000', '2026-12-24');
    const before = await call('GET');
    expect(before.body).toEqual({ state: 'ok', last4: '0000', expires: '2026-12-24', source: 'saved' });

    h.keyCheck.result = 'refused';
    const refused = await call('PUT', { key: NEW_KEY, expires: '2027-01-01' });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'Clé refusée par Anthropic, rien n’a changé' });

    h.keyCheck.result = 'unreachable';
    const unreachable = await call('PUT', { key: NEW_KEY });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body).toEqual({ error: 'Anthropic injoignable, rien n’a changé' });

    expect((await call('GET')).body).toEqual(before.body);
    expect(currentKey(h.db, secretKey, {}, 'anthropic')?.key).toBe('sk-ant-test-old-0000');
    expect(getSetting(h.db, 'anthropic.expires', undefined)).toBe('2026-12-24');
  });

  it('PUT refuses without ACEDIA_SECRET_KEY, without a key, or with an invalid date', async () => {
    const h = makeHarness();
    const call = await client(h);
    const noSecret = await call('PUT', { key: NEW_KEY });
    expect(noSecret.status).toBe(400);
    expect(noSecret.body.error).toContain('ACEDIA_SECRET_KEY');
    expect(h.keyCheck.calls).toEqual([]);

    const h2 = makeHarness({ secretKey: randomBytes(32).toString('base64') });
    const call2 = await client(h2);
    expect((await call2('PUT', {})).status).toBe(400);
    expect((await call2('PUT', { key: '   ' })).status).toBe(400);
    expect((await call2('PUT', { key: NEW_KEY, expires: '01/12/2026' })).status).toBe(400);
    expect((await call2('PUT', { key: NEW_KEY, expires: '2026-02-30' })).status).toBe(400);
    expect(h2.keyCheck.calls).toEqual([]);
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
    saveKey(h.db, secretKey, 'anthropic', 'sk-ant-test-old-0000', '2026-12-24');
    keyRefused(h.db, 'anthropic', h.clock());
    const removed = await call('DELETE');
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ state: 'absent' });
    expect(getSetting(h.db, 'anthropic.expires', undefined)).toBeNull();
    // Nothing is refused any more: the AI simply has no key.
    expect(getState(h.db).degraded).toEqual([]);

    const h2 = makeHarness({ secretKey, llmEnv: { anthropic: { key: ENV_KEY } } });
    const call2 = await client(h2);
    saveKey(h2.db, secretKey, 'anthropic', 'sk-ant-test-old-0000');
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

    const h = makeHarness({ llmEnv: { anthropic: { key: ENV_KEY, expires: '2026-12-24' } } });
    const call = await client(h);
    const ok = await call('GET');
    expect(ok.body).toEqual({ state: 'ok', last4: '9876', expires: '2026-12-24', source: 'env' });
    expect(ok.text).not.toContain(ENV_KEY);

    addDegraded(h.db, 'credit');
    expect((await call('GET')).body.state).toBe('credit');
    keyRefused(h.db, 'anthropic', h.clock());
    const refused = await call('GET');
    expect(refused.body.state).toBe('refused');
    expect(refused.text).not.toContain(ENV_KEY);
  });
});
