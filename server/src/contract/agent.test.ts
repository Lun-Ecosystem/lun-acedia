import { describe, expect, it } from 'vitest';
import { setPaused } from './state.ts';
import type { ChatResult, LlmProvider } from '../llm/types.ts';
import { cardsOf, dayOf, messagesOf, putPinaSettings } from '../pina/store.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';

const usage = { inputTokens: 1000, outputTokens: 100 };
const FILE: ChatResult = {
  text: 'Voilà, c’est proposé.',
  toolCalls: [{ id: 'c1', name: 'mail_file', input: { id: 'm02', boxId: 'factures' } }],
  usage,
  stop: 'tools',
};
const DONE: ChatResult = { text: 'Voilà, c’est proposé.', toolCalls: [], usage, stop: 'end' };

async function setup(script: ChatResult[] = [FILE]) {
  const h = await makeAgendaHarness();
  let rounds = 0;
  const provider: LlmProvider = {
    id: 'anthropic',
    json: () => Promise.reject(new Error('unused')),
    check: () => Promise.resolve('ok'),
    chat: () => Promise.resolve(script[rounds++] ?? DONE),
  };
  h.pina.choice = { provider, model: 'claude-haiku-5-5' };
  const token = await h.pairClient();
  const post = (body: unknown) =>
    h.app.request('/lun/v1/agent', {
      method: 'POST',
      headers: { ...h.auth(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { h, post, rounds: () => rounds };
}

describe('POST /lun/v1/agent', () => {
  it('answers a delegated request with a pending card', async () => {
    const s = await setup();
    const res = await s.post({
      request: 'Range ce mail dans Factures',
      context: { screen: 'mail', mailId: 'm02' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      summary: 'Voilà, c’est proposé.',
      cards: [expect.objectContaining({ action: 'mail.file', effect: 'write', status: 'pending' })],
      refs: [],
      cost: { currency: 'USD', amount: expect.any(Number) },
    });
    expect((await (await s.post({ request: 'x' })).json()).cost.amount).toBeGreaterThan(0);
  });

  it('is in validate mode whatever Pina’s own setting, and shows in the day thread', async () => {
    const s = await setup();
    putPinaSettings(s.h.db, { mode: 'immediate' });
    const { cards } = await (await s.post({ request: 'Range ce mail' })).json();
    expect(cards).toHaveLength(1);
    expect(cardsOf(s.h.db, dayOf(s.h.clock()))[0]!.status).toBe('pending');
    expect(messagesOf(s.h.db, dayOf(s.h.clock()))[0]!.message).toMatchObject({ text: 'Range ce mail' });
  });

  it.each([
    [{ request: 'x', context: { screen: 'mail', nope: 1 } }],
    [{ request: 'x', context: { mailId: 'a'.repeat(201) } }],
    [{ request: 'x', context: { screen: 'inconnu' } }],
    [{ request: '' }],
  ])('rejects %j', async (body) => {
    const s = await setup();
    expect((await s.post(body)).status).toBe(400);
    expect(s.rounds()).toBe(0);
  });

  it('says so without a provider', async () => {
    const s = await setup();
    s.h.pina.choice = undefined;
    const res = await s.post({ request: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: expect.stringContaining('Aucun modèle'), cards: [] });
  });

  it('says Acedia is paused, without calling the model', async () => {
    const s = await setup();
    setPaused(s.h.db, true);
    const res = await s.post({ request: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: expect.stringContaining('pause'), cards: [] });
    expect(s.rounds()).toBe(0);
  });
});
