import { describe, expect, it } from 'vitest';
import type { ChatResult, LlmProvider, ToolCall } from '../llm/types.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';
import { message } from '../testing/fake-gmail.ts';
import { dayOf, getCard } from './store.ts';

const usage = { inputTokens: 1000, outputTokens: 100 };
const tool = (name: string, input: unknown, id = 'c1'): ToolCall => ({
  id,
  name: name.replace('.', '_'),
  input,
});
const calls = (...toolCalls: ToolCall[]): ChatResult => ({ text: '', toolCalls, usage, stop: 'tools' });
const answer = (text: string): ChatResult => ({ text, toolCalls: [], usage, stop: 'end' });

const EVENT = { title: 'Dentiste', start: '2026-11-06T15:00:00.000Z', end: '2026-11-06T15:30:00.000Z' };
const CONTEXT = { screen: 'mail' as const };

async function setup(script: ChatResult[]) {
  const h = await makeAgendaHarness();
  h.gmail.deliver(message({ id: 'm1', subject: 'Rendu décalé' }));
  await h.sync();
  await h.syncAgenda();
  let n = 0;
  const requests: unknown[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    json: () => Promise.reject(new Error('unused')),
    check: () => Promise.resolve('ok'),
    chat: (req) => {
      requests.push(structuredClone(req.messages));
      return Promise.resolve(script[n++] ?? answer('Voilà !'));
    },
  };
  h.pina.choice = { provider, model: 'claude-haiku-5-5' };
  const writes = () => h.calls.filter((c) => c.method !== 'GET').length;
  /** Asks Pina something that leaves one card pending. */
  const withCard = async () => {
    const res = await h.call('POST', '/api/pina/messages', { text: 'Fais-le', context: CONTEXT });
    expect(res.status).toBe(200);
    return res.body.cards[0].id as number;
  };
  return { h, requests, writes, withCard };
}

const event = () => calls(tool('event.create', EVENT));

describe('Pina routes', () => {
  it('accept runs the action once and resumes the loop', async () => {
    const s = await setup([event(), answer('C’est fait.')]);
    const id = await s.withCard();
    expect(s.writes()).toBe(0);
    const res = await s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ status: 'done' });
    expect(s.writes()).toBe(1);
    expect(s.requests).toHaveLength(2);
    expect(res.body.messages.at(-1).message).toMatchObject({ role: 'assistant', text: 'C’est fait.' });
    const today = await s.h.call('GET', '/api/pina/today');
    expect(today.body).toMatchObject({ day: dayOf(s.h.clock()), pending: 0 });
  });

  it('two concurrent accepts → one 200, one 409, one Google call', async () => {
    const s = await setup([event()]);
    const id = await s.withCard();
    const both = await Promise.all([
      s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'accept' }),
      s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'accept' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(s.writes()).toBe(1);
  });

  it("yesterday's card → 409 expirée, no Google call", async () => {
    const s = await setup([event()]);
    const id = await s.withCard();
    s.h.advance(26 * 3_600_000);
    const res = await s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'accept' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('expirée');
    expect(s.writes()).toBe(0);
    expect(getCard(s.h.db, id)?.status).toBe('expired');
  });

  it('refuse resumes the loop with a refusal result', async () => {
    const s = await setup([event(), answer('D’accord.')]);
    const id = await s.withCard();
    const res = await s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'refuse' });
    expect(res.status).toBe(200);
    expect(res.body.card.status).toBe('refused');
    expect(s.writes()).toBe(0);
    expect(JSON.stringify(s.requests[1])).toContain('CrOliX a refusé');
    expect((await s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'refuse' })).status).toBe(409);
  });

  it('Modifier input is revalidated (400 on invalid)', async () => {
    const s = await setup([event(), answer('Ok.')]);
    const id = await s.withCard();
    const bad = await s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'accept', input: { title: '' } });
    expect(bad.status).toBe(400);
    expect(s.writes()).toBe(0);
    expect(getCard(s.h.db, id)?.status).toBe('pending');
    const ok = await s.h.call('POST', `/api/pina/cards/${id}`, {
      decision: 'accept',
      input: { ...EVENT, title: 'Dentiste (décalé)' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.card.input.title).toBe('Dentiste (décalé)');
    expect(s.writes()).toBe(1);
  });

  it('undo runs the inverse and marks the journal', async () => {
    const s = await setup([calls(tool('mail.archive', { id: 'm1' })), answer('Archivé.')]);
    const id = await s.withCard();
    expect((await s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'accept' })).status).toBe(200);
    const before = await s.h.call('GET', '/api/journal');
    expect(before.body.items[0]).toMatchObject({ origin: 'pina', action: 'archive', undoneAt: null });
    const undo = await s.h.call('POST', `/api/pina/cards/${id}/undo`);
    expect(undo.status).toBe(200);
    const after = await s.h.call('GET', '/api/journal');
    expect(after.body.items.find((e: { origin: string }) => e.origin === 'pina').undoneAt).not.toBeNull();
    expect((await s.h.call('POST', `/api/pina/cards/${id}/undo`)).status).toBe(409);
  });

  it('undo of an event runs its inverse once; not done → 409', async () => {
    const s = await setup([event()]);
    const id = await s.withCard();
    expect((await s.h.call('POST', `/api/pina/cards/${id}/undo`)).status).toBe(409);
    await s.h.call('POST', `/api/pina/cards/${id}`, { decision: 'accept' });
    const writes = s.writes();
    expect((await s.h.call('POST', `/api/pina/cards/${id}/undo`)).status).toBe(200);
    expect(s.writes()).toBe(writes + 1);
    expect((await s.h.call('POST', `/api/pina/cards/${id}/undo`)).status).toBe(409);
    expect(s.writes()).toBe(writes + 1);
  });

  it('routes require a device token', async () => {
    const s = await setup([]);
    for (const [method, path] of [
      ['GET', '/api/pina/today'],
      ['GET', '/api/pina/days'],
      ['POST', '/api/pina/messages'],
      ['POST', '/api/pina/cards/1'],
      ['POST', '/api/pina/cards/1/undo'],
      ['GET', '/api/pina/settings'],
      ['PUT', '/api/pina/settings'],
    ] as const)
      expect((await s.h.app.request(path, { method })).status, `${method} ${path}`).toBe(401);
  });

  it('PUT /settings bounds are enforced; messages are bounded', async () => {
    const s = await setup([]);
    expect((await s.h.call('PUT', '/api/pina/settings', { retentionDays: 0 })).status).toBe(400);
    expect((await s.h.call('PUT', '/api/pina/settings', { retentionDays: 366 })).status).toBe(400);
    expect((await s.h.call('PUT', '/api/pina/settings', { dailyCapUsd: 51 })).status).toBe(400);
    const ok = await s.h.call('PUT', '/api/pina/settings', { retentionDays: 365, dailyCapUsd: 0 });
    expect(ok.body).toMatchObject({ retentionDays: 365, dailyCapUsd: 0 });
    const text = (t: string) => s.h.call('POST', '/api/pina/messages', { text: t, context: CONTEXT });
    expect((await text('')).status).toBe(400);
    expect((await text('x'.repeat(4001))).status).toBe(400);
    const bad = await s.h.call('POST', '/api/pina/messages', { text: 'a', context: { screen: 'x' } });
    expect(bad.status).toBe(400);
  });
});
