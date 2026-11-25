import { describe, expect, it } from 'vitest';
import { addCard, dayOf, setCardStatus } from '../pina/store.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';
import { message } from '../testing/fake-gmail.ts';

const DAY = { since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z' };

async function setup() {
  const h = await makeAgendaHarness();
  h.gmail.deliver(message({ id: 'in', subject: 'Dedans', date: '2026-11-01T10:00:00.000Z' }));
  h.gmail.deliver(message({ id: 'edge', subject: 'Pile la fin', date: '2026-11-02T00:00:00.000Z' }));
  h.gmail.deliver(message({ id: 'old', subject: 'Avant', date: '2026-10-31T23:59:59.000Z' }));
  await h.sync();
  const act = (input: unknown) => h.call('POST', '/lun/v1/actions/day.digest', input);
  const journal = (at: string, id: string) =>
    h.db
      .prepare(
        "INSERT INTO journal (at, message_id, origin, action, before, after) VALUES (?, ?, 'auto', 'file', '{}', '{}')",
      )
      .run(at, id);
  const card = (status: 'done' | 'pending', at: Date) => {
    const id = addCard(h.db, {
      day: dayOf(at),
      turn: 1,
      callId: `c${status}`,
      action: 'mail.archive',
      input: { id: 'in' },
      effect: 'write',
      now: at,
    });
    if (status === 'done') setCardStatus(h.db, id, 'pending', 'done', { at });
  };
  return { h, act, journal, card };
}

describe('day.digest', () => {
  it('lists mails received in [since, until[ with their ref, newest first', async () => {
    const { act } = await setup();
    const body = (await act(DAY)).body.result;
    expect(body.received).toEqual([
      {
        type: 'mail',
        title: 'Dedans',
        at: '2026-11-01T10:00:00.000Z',
        ref: { type: 'mail', id: 'in', title: 'Dedans' },
      },
    ]);
    expect(body.since).toBe(DAY.since);
  });

  it('lists journal entries and done cards, and counts what waits', async () => {
    const { h, act, journal, card } = await setup();
    journal('2026-11-01T11:00:00.000Z', 'in');
    journal('2026-11-03T11:00:00.000Z', 'in');
    card('done', new Date('2026-11-01T12:00:00.000Z'));
    card('pending', h.clock());
    h.db
      .prepare(
        "INSERT INTO proposals (message_id, box_id, tag_ids, importance, confidence, source, status, created_at) VALUES ('in', NULL, '[]', 'normal', 80, 'ia', 'pending', '2026-11-01T09:00:00.000Z')",
      )
      .run();
    const body = (await act(DAY)).body.result;
    expect(body.done).toHaveLength(2);
    expect(body.done[0]).toMatchObject({ type: 'card.mail.archive', at: '2026-11-01T12:00:00.000Z' });
    expect(body.done[0].ref).toBeUndefined();
    expect(body.done[1]).toMatchObject({
      type: 'journal.file',
      title: 'Dedans',
      ref: { type: 'mail', id: 'in', title: 'Dedans' },
    });
    expect(body.pending).toBe(2);
  });

  it('does not count the pending cards of an earlier day', async () => {
    const { act, card } = await setup();
    card('pending', new Date('2026-11-01T13:00:00.000Z'));
    expect((await act(DAY)).body.result.pending).toBe(0);
  });

  it('leaves out journal entries that were undone', async () => {
    const { h, act, journal } = await setup();
    journal('2026-11-01T11:00:00.000Z', 'in');
    h.db.prepare("UPDATE journal SET undone_at = '2026-11-01T11:05:00.000Z'").run();
    expect((await act(DAY)).body.result.done).toEqual([]);
  });

  it.each([
    [{ since: DAY.until, until: DAY.since }],
    [{ since: DAY.since, until: DAY.since }],
    [{ since: 'pas une date', until: DAY.until }],
    [{ since: '1 Jan 2026', until: DAY.until }],
    [{ since: '2026', until: DAY.until }],
  ])('refuses an empty or unreadable period (400)', async (input) => {
    const { act } = await setup();
    expect((await act(input)).status).toBe(400);
  });
});

describe('day.digest, what waits (only the mails still in the inbox)', () => {
  const propose = (db: Awaited<ReturnType<typeof setup>>['h']['db'], id: string) =>
    db
      .prepare(
        "INSERT INTO proposals (message_id, box_id, tag_ids, importance, confidence, source, status, created_at) VALUES (?, NULL, '[]', 'normal', 80, 'ia', 'pending', '2026-11-01T09:00:00.000Z')",
      )
      .run(id);
  const pendingOf = async (act: Awaited<ReturnType<typeof setup>>['act']) =>
    (await act(DAY)).body.result.pending;

  it('does not count the proposal of a mail archived, trashed, spammed or gone from the cache', async () => {
    const { h, act } = await setup();
    h.gmail.deliver(message({ id: 'arch', labelIds: ['UNREAD'] }));
    h.gmail.deliver(message({ id: 'bin', labelIds: ['INBOX', 'TRASH'] }));
    h.gmail.deliver(message({ id: 'junk', labelIds: ['SPAM'] }));
    await h.sync();
    for (const id of ['in', 'arch', 'bin', 'junk', 'ghost']) propose(h.db, id);
    const body = (await act(DAY)).body.result;
    expect(body.pending).toBe(1);
    // Same date for the four: their order is the index's tie-break, not what this test pins.
    expect(body.received.map((m: { ref: { id: string } }) => m.ref.id).sort()).toEqual([
      'arch',
      'bin',
      'in',
      'junk',
    ]);
    expect(body.done).toEqual([]);
  });

  it('drops by one when the mail is archived by hand, and comes back with the undo', async () => {
    const { h, act } = await setup();
    propose(h.db, 'in');
    expect(await pendingOf(act)).toBe(1);
    const res = await h.call('POST', '/api/mail/batch', { ids: ['in'], op: { kind: 'archive' } });
    expect(res.status).toBe(200);
    expect(await pendingOf(act)).toBe(0);
    expect((await h.call('POST', `/api/journal/${res.body[0].journalId}/undo`)).status).toBe(200);
    expect(await pendingOf(act)).toBe(1);
  });

  it('does not count the proposal of a mail Gmail took out of the inbox', async () => {
    const { h, act } = await setup();
    propose(h.db, 'in');
    h.gmail.relabel('in', [], ['INBOX']);
    await h.sync();
    expect(await pendingOf(act)).toBe(0);
  });

  it('counts it again when the mail is back in the inbox', async () => {
    const { h, act } = await setup();
    propose(h.db, 'in');
    h.gmail.relabel('in', [], ['INBOX']);
    await h.sync();
    h.gmail.relabel('in', ['INBOX'], []);
    await h.sync();
    expect(await pendingOf(act)).toBe(1);
  });

  it('does not count the proposal of a mail purged on Gmail', async () => {
    const { h, act } = await setup();
    propose(h.db, 'in');
    h.gmail.purge('in');
    await h.sync();
    expect(await pendingOf(act)).toBe(0);
  });
});

describe('day.digest without boxes: as before, its texts masked', () => {
  it('masks the titles of the mails and of the journal, and adds neither box nor synthesis', async () => {
    const { h, act, journal } = await setup();
    h.gmail.deliver(message({ id: 'code', subject: 'Votre code 482917', date: '2026-11-01T11:00:00.000Z' }));
    await h.sync();
    journal('2026-11-01T11:30:00.000Z', 'code');
    const body = (await act(DAY)).body.result;
    expect(body.received[0]).toEqual({
      type: 'mail',
      title: 'Votre code [masqué]',
      at: '2026-11-01T11:00:00.000Z',
      ref: { type: 'mail', id: 'code', title: 'Votre code [masqué]' },
    });
    expect(body.done[0]).toMatchObject({
      title: 'Votre code [masqué]',
      ref: { title: 'Votre code [masqué]' },
    });
    expect(JSON.stringify(body)).not.toContain('482917');
  });
});

describe('day.digest with boxes', () => {
  type Seed = { labels: string[]; source?: 'rule' | 'ai'; status?: string; box?: string; synthesis?: string };

  /** One mail per case, all received in the day, with its labels and its proposal. */
  async function boxes(cases: Record<string, Seed>) {
    const s = await setup();
    const b1 = (await s.h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
    const b2 = (await s.h.call('POST', '/api/labels', { name: 'Perso', role: 'box' })).body.id as string;
    const tag = (await s.h.call('POST', '/api/labels', { name: 'Urgent', role: 'tag' })).body.id as string;
    const label = (l: string) => ({ b1, b2, tag })[l as 'b1'] ?? l;
    let minute = 0;
    for (const [id, c] of Object.entries(cases)) {
      const date = new Date(Date.parse('2026-11-01T12:00:00.000Z') + minute++ * 60_000).toISOString();
      s.h.gmail.deliver(message({ id, subject: `Objet ${id}`, date, labelIds: c.labels.map(label) }));
    }
    await s.h.sync();
    for (const [id, c] of Object.entries(cases))
      if (c.source)
        s.h.db
          .prepare(
            `INSERT INTO proposals (message_id, box_id, tag_ids, importance, confidence, source, status, created_at, synthesis)
             VALUES (?, ?, '[]', 'normal', 80, ?, ?, '2026-11-01T12:00:00.000Z', ?)`,
          )
          .run(id, label(c.box ?? 'b1'), c.source, c.status ?? 'auto', c.synthesis ?? null);
    const digest = async (boxIds: string[]) => (await s.act({ ...DAY, boxes: boxIds.map(label) })).body;
    const ids = (items: { ref?: { id: string } }[]) => items.map((i) => i.ref?.id).sort();
    return { ...s, b1, b2, label, digest, ids };
  }

  it('keeps the mails filed in a box asked for with the accord of CrOliX', async () => {
    const s = await boxes({
      rule: { labels: ['b1'], source: 'rule' },
      validated: { labels: ['b1'], source: 'ai', status: 'accepted' },
      corrected: { labels: ['b1'], source: 'ai', status: 'corrected' },
      aiAlone: { labels: ['b1'], source: 'ai', status: 'auto' },
      waiting: { labels: ['INBOX', 'b1'], source: 'ai', status: 'pending' },
      elsewhere: { labels: ['b2'], source: 'rule' },
      trashed: { labels: ['b1', 'TRASH'], source: 'rule' },
      spammed: { labels: ['b1', 'SPAM'], source: 'rule' },
      byHand: { labels: ['b1'] },
    });
    const { result } = await s.digest(['b1']);
    expect(s.ids(result.received)).toEqual(['corrected', 'rule', 'validated']);
    expect(result.received.find((i: { ref: { id: string } }) => i.ref.id === 'rule').box).toEqual({
      id: s.b1,
      name: 'École',
    });
  });

  it('a mail moved since into a box asked for is kept, with the box it arrived in', async () => {
    const s = await boxes({ moved: { labels: ['b2'], source: 'rule', box: 'b2' } });
    expect((await s.digest(['b1'])).result.received).toEqual([]);
    s.h.gmail.relabel('moved', [s.b1], [s.b2]);
    await s.h.sync();
    const [item] = (await s.digest(['b1'])).result.received;
    expect(item).toMatchObject({ ref: { id: 'moved' }, box: { id: s.b1, name: 'École' } });
  });

  it('filed alone by the AI then filed by hand: accepted in the proposed box, corrected elsewhere, both kept', async () => {
    const s = await boxes({
      same: { labels: ['INBOX'], source: 'ai', status: 'auto', box: 'b1' },
      other: { labels: ['INBOX'], source: 'ai', status: 'auto', box: 'b2' },
    });
    const file = (id: string) =>
      s.h.call('POST', '/api/mail/batch', { ids: [id], op: { kind: 'file', boxId: s.b1 } });
    expect((await file('same')).status).toBe(200);
    expect((await file('other')).status).toBe(200);
    expect(s.h.db.prepare('SELECT message_id, status FROM proposals ORDER BY message_id').all()).toEqual([
      { message_id: 'other', status: 'corrected' },
      { message_id: 'same', status: 'accepted' },
    ]);
    expect(s.ids((await s.digest(['b1'])).result.received)).toEqual(['other', 'same']);
  });

  it('an undo puts the status back', async () => {
    const s = await boxes({ same: { labels: ['INBOX'], source: 'ai', status: 'auto', box: 'b1' } });
    const res = await s.h.call('POST', '/api/mail/batch', {
      ids: ['same'],
      op: { kind: 'file', boxId: s.b1 },
    });
    expect((await s.h.call('POST', `/api/journal/${res.body[0].journalId}/undo`)).status).toBe(200);
    expect(s.h.db.prepare("SELECT status FROM proposals WHERE message_id = 'same'").get()).toEqual({
      status: 'auto',
    });
    expect((await s.digest(['b1'])).result.received).toEqual([]);
  });

  it('carries the synthesis when there is one, masked; none for null or []', async () => {
    const s = await boxes({
      two: {
        labels: ['b1'],
        source: 'rule',
        synthesis: JSON.stringify(['Réunion jeudi.', 'Code 482917 joint.']),
      },
      empty: { labels: ['b1'], source: 'rule', synthesis: '[]' },
      none: { labels: ['b1'], source: 'rule' },
    });
    const items = (await s.digest(['b1'])).result.received as { ref: { id: string }; synthesis?: string }[];
    const by = Object.fromEntries(items.map((i) => [i.ref.id, i]));
    expect(by.two!.synthesis).toBe('Réunion jeudi.\nCode [masqué] joint.');
    expect(by.empty).not.toHaveProperty('synthesis');
    expect(by.none).not.toHaveProperty('synthesis');
  });

  it('done keeps the journal of the kept mails only, the agent cards leave; pending does not change', async () => {
    const s = await boxes({
      rule: { labels: ['b1'], source: 'rule' },
      elsewhere: { labels: ['b2'], source: 'rule' },
    });
    s.journal('2026-11-01T13:00:00.000Z', 'rule');
    s.journal('2026-11-01T13:01:00.000Z', 'elsewhere');
    s.card('done', new Date('2026-11-01T14:00:00.000Z'));
    s.card('pending', s.h.clock());
    const all = (await s.act(DAY)).body.result;
    const { result } = await s.digest(['b1']);
    expect(result.done).toEqual([
      expect.objectContaining({
        type: 'journal.file',
        ref: expect.objectContaining({ id: 'rule' }),
        box: { id: s.b1, name: 'École' },
      }),
    ]);
    expect(result.pending).toBe(all.pending);
  });

  it('boxes: [] keeps nothing; an unknown key is 400', async () => {
    const s = await boxes({ rule: { labels: ['b1'], source: 'rule' } });
    const { result } = await s.digest([]);
    expect(result.received).toEqual([]);
    expect(result.done).toEqual([]);
    expect((await s.act({ ...DAY, boxes: [s.b1], boites: [] })).status).toBe(400);
    expect((await s.act({ ...DAY, extra: 1 })).status).toBe(400);
  });

  it('filters before the limit of 200', async () => {
    const s = await boxes({ kept: { labels: ['b1'], source: 'rule' } });
    for (let i = 0; i < 210; i++)
      s.h.gmail.deliver(
        message({ id: `n${i}`, subject: 'x', date: '2026-11-01T20:00:00.000Z', labelIds: [s.b2] }),
      );
    await s.h.sync();
    expect(s.ids((await s.digest(['b1'])).result.received)).toEqual(['kept']);
  });
});
