import { describe, expect, it } from 'vitest';
import { addCard, dayOf, getCard } from '../pina/store.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';

const EVENT = { title: 'Dentiste', start: '2026-11-06T15:00:00.000Z', end: '2026-11-06T15:30:00.000Z' };

async function setup() {
  const h = await makeAgendaHarness();
  await h.syncAgenda();
  const token = await h.pairClient();
  const get = (path: string) => h.app.request(`/lun/v1${path}`, { headers: h.auth(token) });
  const post = (path: string, body: unknown) =>
    h.app.request(`/lun/v1${path}`, {
      method: 'POST',
      headers: { ...h.auth(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const card = (over: { day?: string; action?: string; input?: unknown; effect?: string } = {}) =>
    addCard(h.db, {
      day: dayOf(h.clock()),
      turn: 1,
      callId: 'c1',
      action: 'event.create',
      input: EVENT,
      effect: 'write',
      now: h.clock(),
      ...over,
    });
  const writes = () => h.calls.filter((c) => c.method !== 'GET').length;
  return { h, get, post, card, writes, logs: h.logs };
}

describe('/lun/v1/cards', () => {
  it('lists pending cards in the contract format', async () => {
    const s = await setup();
    const id = s.card();
    const res = await s.get('/cards');
    expect(res.status).toBe(200);
    const { cards } = await res.json();
    expect(cards).toEqual([
      {
        id: String(id),
        action: 'event.create',
        effect: 'write',
        title: expect.any(String),
        lines: expect.arrayContaining([expect.stringContaining('Dentiste')]),
        status: 'pending',
        at: getCard(s.h.db, id)!.createdAt,
      },
    ]);
  });

  it('a mail card carries its link', async () => {
    const s = await setup();
    s.card({ action: 'mail.archive', input: { id: 'm 1' } });
    s.card();
    const { cards } = await (await s.get('/cards')).json();
    const byAction = (a: string) => cards.find((c: { action: string }) => c.action === a);
    expect(byAction('mail.archive').link).toBe('#/mail/m%201');
    expect(byAction('event.create')).not.toHaveProperty('link');
  });

  it('filters by status, newest first', async () => {
    const s = await setup();
    const a = s.card();
    const b = s.card();
    const c = s.card();
    await s.post(`/cards/${a}/refuse`, {});
    const pending = (await (await s.get('/cards')).json()).cards;
    expect(pending.map((x: { id: string }) => x.id)).toEqual([String(c), String(b)]);
    const refused = (await (await s.get('/cards?status=refused')).json()).cards;
    expect(refused.map((c: { id: string }) => c.id)).toEqual([String(a)]);
    expect((await s.get('/cards?status=nope')).status).toBe(400);
  });

  it('leaves out the pending cards of an earlier day', async () => {
    const s = await setup();
    const old = s.card({ day: '2000-01-01' });
    const today = s.card();
    const pending = (await (await s.get('/cards?status=pending')).json()).cards;
    expect(pending.map((x: { id: string }) => x.id)).toEqual([String(today)]);
    expect(getCard(s.h.db, old)!.status).toBe('expired');
  });

  it('rejects a malformed accept body and keeps the card pending; an empty body accepts', async () => {
    const s = await setup();
    const a = s.card();
    const bad = await s.h.app.request(`/lun/v1/cards/${a}/accept`, {
      method: 'POST',
      headers: { ...s.h.auth(await s.h.pairClient()), 'content-type': 'application/json' },
      body: '{"input":{"title":',
    });
    expect(bad.status).toBe(400);
    expect(getCard(s.h.db, a)!.status).toBe('pending');
    expect(s.writes()).toBe(0);
    const empty = await s.h.app.request(`/lun/v1/cards/${a}/accept`, {
      method: 'POST',
      headers: s.h.auth(await s.h.pairClient()),
    });
    expect(empty.status).toBe(200);
    expect(getCard(s.h.db, a)!.status).toBe('done');
  });

  it('accept runs the action, refuse refuses', async () => {
    const s = await setup();
    const a = s.card();
    const accepted = await s.post(`/cards/${a}/accept`, {});
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).card).toMatchObject({ id: String(a), status: 'done' });
    expect(s.writes()).toBe(1);
    const b = s.card();
    const refused = await s.post(`/cards/${b}/refuse`, {});
    expect((await refused.json()).card.status).toBe('refused');
    expect(s.writes()).toBe(1);
  });

  it('two accepts at once run the action once', async () => {
    const s = await setup();
    const id = s.card();
    const both = await Promise.all([s.post(`/cards/${id}/accept`, {}), s.post(`/cards/${id}/accept`, {})]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(s.writes()).toBe(1);
  });

  it('refuses yesterday’s card and unknown ids', async () => {
    const s = await setup();
    const old = s.card({ day: '2000-01-01' });
    const res = await s.post(`/cards/${old}/accept`, {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Carte expirée');
    expect(s.writes()).toBe(0);
    expect((await s.post('/cards/9999/accept', {})).status).toBe(404);
  });

  it('refuses an input on a deletion', async () => {
    const s = await setup();
    const id = s.card({ action: 'event.delete', input: { id: 'e1' }, effect: 'delete' });
    const res = await s.post(`/cards/${id}/accept`, { input: { id: 'e2' } });
    expect(res.status).toBe(400);
    expect(getCard(s.h.db, id)!.status).toBe('pending');
  });

  it('health says the satellite has an agent', async () => {
    const s = await setup();
    expect((await (await s.get('/health')).json()).agent).toBe(true);
  });

  it('accept { input } edits a write card before running it', async () => {
    const s = await setup();
    const id = s.card();
    const res = await s.post(`/cards/${id}/accept`, { input: { ...EVENT, title: 'Ophtalmo' } });
    expect(res.status).toBe(200);
    expect((await res.json()).card.status).toBe('done');
    expect(getCard(s.h.db, id)).toMatchObject({ edited: true, input: { title: 'Ophtalmo' } });
  });

  it('a failing resume does not turn a decided card into an error', async () => {
    const s = await setup();
    s.h.pina.choice = {
      provider: {
        id: 'anthropic',
        json: () => Promise.reject(new Error('unused')),
        check: () => Promise.resolve('ok'),
        chat: () => Promise.reject(new Error('boom')),
      },
      model: 'claude-haiku-5-5',
    };
    const id = s.card();
    const res = await s.post(`/cards/${id}/accept`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).card.status).toBe('done');
    expect(s.logs.join()).toContain('boom');
  });
});
