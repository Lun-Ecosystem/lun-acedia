import { describe, expect, it } from 'vitest';
import { putSetting } from '../db.ts';
import { setStoredLabels } from '../gmail/store.ts';
import { addCard, dayOf, getCard } from '../pina/store.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import type { Classification, Classifier } from '../triage/classifier.ts';
import { getProposal, triageNew } from '../triage/pipeline.ts';
import { setProposalStatus } from '../triage/proposals.ts';
import type { ContractCard } from '../types.ts';

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
        kind: 'Créer un événement',
        title: expect.any(String),
        lines: expect.arrayContaining([expect.stringContaining('Dentiste')]),
        status: 'pending',
        at: getCard(s.h.db, id)!.createdAt,
      },
    ]);
  });

  it('gives each card its kind, and sends only on a reply draft', async () => {
    const s = await setup();
    const reply = { to: 'paul@example.org', subject: 'Re: Orion', text: 'Jeudi.' };
    s.card();
    s.card({ action: 'draft.create', input: { ...reply, replyTo: 'm1' } });
    s.card({ action: 'draft.create', input: reply });
    const { cards } = await (await s.get('/cards')).json();
    const drafts = cards.filter((c: { action: string }) => c.action === 'draft.create');
    expect(cards.find((c: { action: string }) => c.action === 'event.create')).not.toHaveProperty('sends');
    expect(drafts.filter((c: { sends?: boolean }) => c.sends)).toHaveLength(1);
    expect(drafts.find((c: { sends?: boolean }) => c.sends)).toMatchObject({
      kind: 'Brouillon de réponse',
      sends: true,
    });
    expect(drafts.find((c: { sends?: boolean }) => !c.sends)).not.toHaveProperty('sends');
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

/** A mailbox with two boxes and an Urgent tag, and a classifier that answers by subject. */
async function proposals(answers: Record<string, Partial<Classification>>) {
  const h = await makeGmailHarness();
  const b1 = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
  const b2 = (await h.call('POST', '/api/labels', { name: 'Perso', role: 'box' })).body.id as string;
  const urgent = (await h.call('POST', '/api/labels', { name: 'Urgent', role: 'tag' })).body.id as string;
  const classifier: Classifier = {
    model: 'claude-haiku-5-5',
    async classify({ mail }) {
      return {
        boxId: b1,
        tagIds: [],
        importance: 'normal',
        confidence: 50,
        reason: 'Expéditeur déjà rangé en École.',
        synthesis: ['Une réunion est prévue jeudi.'],
        usage: { inputTokens: 1, outputTokens: 1 },
        ...answers[mail.subject],
      };
    },
  };
  const deliver = async (...mails: { id: string; subject: string }[]) => {
    for (const m of mails) h.gmail.deliver(message({ date: '2026-11-02T08:30:00.000Z', ...m }));
    await triageNew({ ...h.deps, classifier, log: () => undefined }, (await h.sync()).added);
  };
  const token = await h.pairClient('core');
  const request = (path: string, init: RequestInit = {}) =>
    h.app.request(`/lun/v1${path}`, {
      ...init,
      headers: { ...h.auth(token), 'content-type': 'application/json' },
    });
  const cards = async (query = '') =>
    (await (await request(`/cards${query}`)).json()).cards as ContractCard[];
  const card = async (id: string) => (await cards()).find((c) => c.id === `mail:${id}`);
  return { h, b1, b2, urgent, classifier, deliver, request, cards, card };
}

describe('/lun/v1/cards: the proposals of the triage', () => {
  it('serves without an agent, each waiting proposal as a card', async () => {
    const s = await proposals({});
    s.h.pina.choice = undefined;
    await s.deliver({ id: 'm1', subject: 'Réunion' });
    expect((await s.cards()).map((c) => c.id)).toEqual(['mail:m1']);
  });

  it('writes the card from the proposal', async () => {
    const s = await proposals({});
    await s.deliver({ id: 'm1', subject: 'Réunion' });
    expect(await s.card('m1')).toEqual({
      id: 'mail:m1',
      action: 'mail.validate',
      effect: 'write',
      kind: 'Proposition de tri',
      title: 'Réunion',
      lines: ['Une réunion est prévue jeudi.'],
      reason: 'Expéditeur déjà rangé en École.',
      importance: 'low',
      fields: [
        {
          name: 'box',
          label: 'Boîte',
          value: [s.b1],
          choices: [
            { value: s.b2, label: 'Perso' },
            { value: s.b1, label: 'École' },
            { value: 'trash', label: 'Corbeille' },
            { value: 'spam', label: 'Spam' },
          ],
        },
        {
          name: 'tags',
          label: 'Étiquettes',
          value: [],
          choices: [{ value: s.urgent, label: 'Urgent' }],
          multiple: true,
        },
      ],
      status: 'pending',
      at: getProposal(s.h.db, 'm1')!.createdAt,
      link: '#/mail/m1',
    });
  });

  it('a proposal without a box has only its tags field', async () => {
    const s = await proposals({ Flou: { boxId: null } });
    await s.deliver({ id: 'm1', subject: 'Flou' });
    expect((await s.card('m1'))!.fields!.map((f) => f.name)).toEqual(['tags']);
  });

  it('serves only what « À valider » shows: not a mail out of the inbox, not an auto or a refused one', async () => {
    const s = await proposals({ Sûr: { confidence: 90 } });
    putSetting(s.h.db, 'threshold', 80);
    await s.deliver({ id: 'auto', subject: 'Sûr' });
    putSetting(s.h.db, 'threshold', 100);
    await s.deliver(
      { id: 'gone', subject: 'a' },
      { id: 'refused', subject: 'b' },
      { id: 'kept', subject: 'c' },
    );
    setStoredLabels(s.h.db, 'gone', [s.b2]);
    setProposalStatus(s.h.db, 'refused', 'refused');
    expect((await s.cards()).map((c) => c.id)).toEqual(['mail:kept']);
  });

  it('importance: normal when the triage says urgent, low otherwise, none included', async () => {
    const s = await proposals({
      u: { importance: 'urgent' },
      n: { importance: 'normal' },
      i: { importance: 'info' },
      z: { importance: 'none' },
    });
    await s.deliver(
      { id: 'u', subject: 'u' },
      { id: 'n', subject: 'n' },
      { id: 'i', subject: 'i' },
      { id: 'z', subject: 'z' },
    );
    const by = Object.fromEntries((await s.cards()).map((c) => [c.id, c.importance]));
    expect(by).toEqual({ 'mail:u': 'normal', 'mail:n': 'low', 'mail:i': 'low', 'mail:z': 'low' });
  });

  it('bulk from min(bulk threshold, threshold), computed by the server', async () => {
    const s = await proposals({ a: { confidence: 84 }, b: { confidence: 85 }, c: { confidence: 86 } });
    await s.deliver({ id: 'a', subject: 'a' }, { id: 'b', subject: 'b' }, { id: 'c', subject: 'c' });
    const bulk = async () => Object.fromEntries((await s.cards()).map((c) => [c.id, c.bulk]));
    expect(await bulk()).toEqual({ 'mail:a': undefined, 'mail:b': true, 'mail:c': true });
    // The threshold drops under the bulk threshold: the line follows it.
    putSetting(s.h.db, 'threshold', 84);
    expect(await bulk()).toEqual({ 'mail:a': true, 'mail:b': true, 'mail:c': true });
    const pending = await s.h.call('GET', '/api/mail?view=pending');
    const views = Object.fromEntries(
      pending.body.items.map((m: { id: string; proposal: { bulk?: true } }) => [m.id, m.proposal.bulk]),
    );
    expect(views).toEqual({ a: true, b: true, c: true });
    putSetting(s.h.db, 'threshold', 100);
    const again = await s.h.call('GET', '/api/mail?view=pending');
    expect(again.body.items.find((m: { id: string }) => m.id === 'a').proposal).not.toHaveProperty('bulk');
  });

  it('a card that sends is never bulk, and no card has both fields and options', async () => {
    const s = await proposals({ a: { confidence: 99 } });
    await s.deliver({ id: 'a', subject: 'a' });
    addCard(s.h.db, {
      day: dayOf(s.h.clock()),
      turn: 1,
      callId: 'd1',
      action: 'draft.create',
      input: { to: 'paul@example.org', subject: 'Re: a', text: 'Jeudi.', replyTo: 'a' },
      effect: 'write',
      now: s.h.clock(),
    });
    const cards = await s.cards();
    expect(cards.find((c) => c.sends)).not.toHaveProperty('bulk');
    expect(cards.find((c) => c.id === 'mail:a')).toMatchObject({ bulk: true });
    for (const c of cards) expect(c.fields !== undefined && 'options' in c).toBe(false);
  });

  it('masks the title, lines and reason of a proposal, and those of the agent cards from a mail', async () => {
    const s = await proposals({
      'Votre code 482917': {
        reason: 'Le code 482917 est donné.',
        synthesis: ['Lien www.exemple.test/r/abc à suivre.'],
      },
    });
    await s.deliver({ id: 'm1', subject: 'Votre code 482917' });
    const base = { day: dayOf(s.h.clock()), turn: 1, effect: 'write' as const, now: s.h.clock() };
    addCard(s.h.db, { ...base, callId: 'a1', action: 'mail.archive', input: { id: 'm1' } });
    addCard(s.h.db, {
      ...base,
      callId: 'a2',
      action: 'draft.create',
      input: { to: 'p@example.org', subject: 'Code 482917', text: 'PIN : 1234' },
    });
    addCard(s.h.db, {
      ...base,
      callId: 'a3',
      action: 'event.create',
      input: { ...EVENT, title: 'Rendez-vous 482917' },
    });
    const cards = await s.cards();
    expect(cards.find((c) => c.id === 'mail:m1')).toMatchObject({
      title: 'Votre code [masqué]',
      lines: ['Lien [masqué] à suivre.'],
      reason: 'Le code [masqué] est donné.',
    });
    for (const action of ['mail.archive', 'draft.create']) {
      const text = JSON.stringify(cards.find((c) => c.action === action));
      expect(text).not.toContain('482917');
      expect(text).not.toContain('1234');
    }
    expect(JSON.stringify(cards.find((c) => c.action === 'event.create'))).toContain('482917');
  });

  it('orders every card by `at`, newest first; status=done serves the agent only', async () => {
    const s = await proposals({});
    await s.deliver({ id: 'old', subject: 'a' });
    s.h.advance(60_000);
    const agent = addCard(s.h.db, {
      day: dayOf(s.h.clock()),
      turn: 1,
      callId: 'c1',
      action: 'event.create',
      input: EVENT,
      effect: 'write',
      now: s.h.clock(),
    });
    s.h.advance(60_000);
    await s.deliver({ id: 'new', subject: 'b' });
    expect((await s.cards()).map((c) => c.id)).toEqual(['mail:new', String(agent), 'mail:old']);
    setProposalStatus(s.h.db, 'old', 'accepted');
    expect((await s.cards('?status=done')).map((c) => c.id)).toEqual([]);
  });
});
