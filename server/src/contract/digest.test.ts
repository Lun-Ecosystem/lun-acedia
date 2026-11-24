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
    expect(body.received.map((m: { ref: { id: string } }) => m.ref.id)).toEqual([
      'in',
      'arch',
      'bin',
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
