import { describe, expect, it } from 'vitest';
import { fileMail, trashMail } from '../gmail/actions.ts';
import { getStoredMessage } from '../gmail/store.ts';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { getExample } from './examples.ts';
import { ConflictError, logAuto, parisDayStart, todayStats } from './journal.ts';
import { correct, getProposal, refuse, validate } from './pipeline.ts';
import { claim, saveProposal, setProposalStatus } from './proposals.ts';

async function setup() {
  const h = await makeGmailHarness([message({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] })]);
  const ecole = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
  const perso = (await h.call('POST', '/api/labels', { name: 'Perso', role: 'box' })).body.id as string;
  return { h, ecole, perso };
}

describe('journal', () => {
  it('lists automatic actions, newest first', async () => {
    const { h, ecole } = await setup();
    const change = await fileMail(h.deps, 'm1', ecole);
    logAuto(h.db, change, 'rule', 'file', h.clock());
    const { body } = await h.call('GET', '/api/journal');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      messageId: 'm1',
      origin: 'rule',
      action: 'file',
      before: ['INBOX', 'UNREAD'],
      after: ['UNREAD', ecole],
      undoneAt: null,
      subject: 'Sujet m1',
    });
  });

  it('undoes a filing: the labels from before come back', async () => {
    const { h, ecole } = await setup();
    const id = logAuto(h.db, await fileMail(h.deps, 'm1', ecole), 'ai', 'file', h.clock());
    const { status } = await h.call('POST', `/api/journal/${id}/undo`);
    expect(status).toBe(200);
    expect(h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
    expect(getStoredMessage(h.db, 'm1')?.labels.sort()).toEqual(['INBOX', 'UNREAD']);
    const { body } = await h.call('GET', '/api/journal');
    expect(body.items[0].undoneAt).toBe('2026-11-02T08:00:00.000Z');
  });

  it('undoes a trashing', async () => {
    const { h } = await setup();
    const id = logAuto(h.db, await trashMail(h.deps, 'm1'), 'ai', 'trash', h.clock());
    await h.call('POST', `/api/journal/${id}/undo`);
    expect(h.gmail.messages.get('m1')!.labelIds).not.toContain('TRASH');
    expect(h.gmail.messages.get('m1')!.labelIds).toContain('INBOX');
  });

  it('refuses to undo when the mail changed since, and changes nothing', async () => {
    const { h, ecole, perso } = await setup();
    const id = logAuto(h.db, await fileMail(h.deps, 'm1', ecole), 'ai', 'file', h.clock());
    h.gmail.relabel('m1', [perso], [ecole]);
    const { status, body } = await h.call('POST', `/api/journal/${id}/undo`);
    expect(status).toBe(409);
    expect(body.error).toBe('Le mail a changé depuis, annulation refusée');
    expect(h.gmail.messages.get('m1')!.labelIds).toContain(perso);
  });

  it('still undoes after the mail was only read', async () => {
    const { h, ecole } = await setup();
    const id = logAuto(h.db, await fileMail(h.deps, 'm1', ecole), 'ai', 'file', h.clock());
    h.gmail.relabel('m1', [], ['UNREAD']);
    expect((await h.call('POST', `/api/journal/${id}/undo`)).status).toBe(200);
    expect(h.gmail.messages.get('m1')!.labelIds).toContain('INBOX');
  });

  it('refuses a second undo', async () => {
    const { h, ecole } = await setup();
    const id = logAuto(h.db, await fileMail(h.deps, 'm1', ecole), 'ai', 'file', h.clock());
    await h.call('POST', `/api/journal/${id}/undo`);
    expect((await h.call('POST', `/api/journal/${id}/undo`)).status).toBe(409);
  });

  it('answers 404 for an unknown entry', async () => {
    const { h } = await setup();
    expect((await h.call('POST', '/api/journal/999/undo')).status).toBe(404);
  });
});

describe('user actions', () => {
  async function pending() {
    const s = await setup();
    claim(s.h.db, 'm1', s.h.clock());
    saveProposal(s.h.db, {
      messageId: 'm1',
      boxId: s.ecole,
      tagIds: [],
      importance: 'none',
      confidence: 50,
      source: 'ai',
      status: 'pending',
    });
    return s;
  }

  it('validate then undo: labels, pending proposal and no example', async () => {
    const s = await pending();
    const res = await s.h.call('POST', '/api/mail/m1/validate');
    expect(res.status).toBe(200);
    expect(typeof res.body.journalId).toBe('number');
    expect(getExample(s.h.db, 'm1')).not.toBeNull();
    expect((await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`)).status).toBe(200);
    expect(s.h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(getExample(s.h.db, 'm1')).toBeNull();
  });

  it('validate then undo restores the example from before', async () => {
    const s = await pending();
    s.h.db
      .prepare(
        "INSERT INTO examples (message_id, from_addr, from_domain, subject, box_id, tag_ids, at) VALUES ('m1','prof@ecole.fr','ecole.fr','Sujet m1','old','[]','2026-01-01T00:00:00.000Z')",
      )
      .run();
    const res = await s.h.call('POST', '/api/mail/m1/validate');
    expect(getExample(s.h.db, 'm1')?.boxId).toBe(s.ecole);
    await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`);
    expect(getExample(s.h.db, 'm1')).toMatchObject({ boxId: 'old', at: '2026-01-01T00:00:00.000Z' });
  });

  it('correct then undo removes the example that did not exist', async () => {
    const s = await pending();
    const res = await s.h.call('POST', '/api/mail/m1/correct', { boxId: s.perso, tagIds: [] });
    expect(typeof res.body.journalId).toBe('number');
    expect(getProposal(s.h.db, 'm1')?.status).toBe('corrected');
    await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(getExample(s.h.db, 'm1')).toBeNull();
    expect(s.h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
  });

  it('archive then undo puts the mail back in the inbox', async () => {
    const { h } = await setup();
    const res = await h.call('POST', '/api/mail/m1/archive');
    expect(typeof res.body.journalId).toBe('number');
    expect(h.gmail.messages.get('m1')!.labelIds).not.toContain('INBOX');
    expect((await h.call('POST', `/api/journal/${res.body.journalId}/undo`)).status).toBe(200);
    expect(h.gmail.messages.get('m1')!.labelIds).toContain('INBOX');
  });

  it('a manual file then undo: labels back and the proposal pending again', async () => {
    const s = await pending();
    const res = await s.h.call('POST', '/api/mail/m1/file', { boxId: s.perso });
    expect(typeof res.body.journalId).toBe('number');
    expect(getProposal(s.h.db, 'm1')?.status).toBe('corrected');
    expect((await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`)).status).toBe(200);
    expect(s.h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
  });

  it('a batch file then undo puts the proposal back too', async () => {
    const s = await pending();
    const op = { kind: 'file', boxId: s.ecole };
    const res = await s.h.call('POST', '/api/mail/batch', { ids: ['m1'], op });
    expect(getProposal(s.h.db, 'm1')?.status).toBe('accepted');
    await s.h.call('POST', `/api/journal/${res.body[0].journalId}/undo`);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(s.h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
  });

  it('a user trash then undo takes the mail out of the trash', async () => {
    const { h } = await setup();
    const res = await h.call('POST', '/api/mail/m1/trash');
    expect(h.gmail.messages.get('m1')!.labelIds).toContain('TRASH');
    expect((await h.call('POST', `/api/journal/${res.body.journalId}/undo`)).status).toBe(200);
    expect(h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
  });

  it('a spam report then undo: SPAM removed, INBOX back', async () => {
    const { h } = await setup();
    const res = await h.call('POST', '/api/mail/m1/spam');
    expect(h.gmail.messages.get('m1')!.labelIds).toContain('SPAM');
    expect((await h.call('POST', `/api/journal/${res.body.journalId}/undo`)).status).toBe(200);
    expect(h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
    expect(getStoredMessage(h.db, 'm1')?.labels.sort()).toEqual(['INBOX', 'UNREAD']);
  });

  for (const [label, view] of [
    ['TRASH', 'trash'],
    ['SPAM', 'spam'],
  ] as const) {
    it(`filing a mail out of ${view} moves it into the box, and the undo puts it back`, async () => {
      const { h, ecole } = await setup();
      h.gmail.relabel('m1', [label], ['INBOX']);
      await h.sync();
      expect((await h.call('GET', `/api/mail?view=${view}`)).body.items).toHaveLength(1);
      const res = await h.call('POST', '/api/mail/m1/file', { boxId: ecole });
      expect(res.status).toBe(200);
      expect(h.gmail.messages.get('m1')!.labelIds.sort()).toEqual([ecole, 'UNREAD'].sort());
      expect((await h.call('GET', `/api/mail?view=${view}`)).body.items).toHaveLength(0);
      expect((await h.call('GET', `/api/mail?view=box:${ecole}`)).body.items).toHaveLength(1);
      expect((await h.call('POST', `/api/journal/${res.body.journalId}/undo`)).status).toBe(200);
      expect(h.gmail.messages.get('m1')!.labelIds.sort()).toEqual([label, 'UNREAD'].sort());
    });
  }

  it('batch returns a journalId for each mail', async () => {
    const { h } = await setup();
    const res = await h.call('POST', '/api/mail/batch', { ids: ['m1'], op: { kind: 'trash' } });
    expect(res.body).toHaveLength(1);
    expect(typeof res.body[0].journalId).toBe('number');
  });

  it('refuses the undo when Gmail shows other labels, and changes nothing', async () => {
    const s = await pending();
    const res = await s.h.call('POST', '/api/mail/m1/validate');
    s.h.gmail.relabel('m1', [s.perso], [s.ecole]);
    const undone = await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`);
    expect(undone.status).toBe(409);
    expect(undone.body.error).toBe('Le mail a changé depuis, annulation refusée');
    expect(s.h.gmail.messages.get('m1')!.labelIds).toContain(s.perso);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('accepted');
    expect(getExample(s.h.db, 'm1')?.boxId).toBe(s.ecole);
    const { body } = await s.h.call('GET', '/api/journal');
    expect(body.items[0].undoneAt).toBeNull();
  });

  it('refuses a second undo', async () => {
    const s = await pending();
    const res = await s.h.call('POST', '/api/mail/m1/validate');
    await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`);
    const again = await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Action déjà annulée');
  });
});

describe('a batch action', () => {
  async function batchSetup(count: number) {
    const ids = Array.from({ length: count }, (_, i) => `m${i + 1}`);
    const h = await makeGmailHarness(ids.map((id) => message({ id, labelIds: ['INBOX', 'UNREAD'] })));
    const ecole = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
    return { h, ids, ecole };
  }

  it('that fails midway leaves the mails already done in the journal, each undoable and learnt', async () => {
    const { h, ids, ecole } = await batchSetup(20);
    h.gmail.purge('m12'); // gone from Gmail, still in the cache: Google answers 404
    const res = await h.call('POST', '/api/mail/batch', { ids, op: { kind: 'file', boxId: ecole } });
    expect(res).toEqual({ status: 404, body: { error: 'Mail introuvable' } });
    const done = ids.slice(0, 11);
    const items = (await h.call('GET', '/api/journal')).body.items as { id: number; messageId: string }[];
    expect(items.map((e) => e.messageId).reverse()).toEqual(done);
    for (const id of done) expect(getExample(h.db, id)?.boxId).toBe(ecole);
    for (const e of items) expect((await h.call('POST', `/api/journal/${e.id}/undo`)).status).toBe(200);
    for (const id of done) expect(h.gmail.messages.get(id)!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
  });

  it('that passes whole answers each change with its journal id', async () => {
    const { h, ecole } = await batchSetup(2);
    const res = await h.call('POST', '/api/mail/batch', {
      ids: ['m1', 'm2'],
      op: { kind: 'file', boxId: ecole },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      ['m1', 'm2'].map((id) => ({
        id,
        before: ['INBOX', 'UNREAD'],
        after: ['UNREAD', ecole],
        journalId: expect.any(Number),
      })),
    );
  });
});

describe('the journal keeps one line per gesture', () => {
  it('a batch of two mails writes two lines', async () => {
    const h = await makeGmailHarness(
      ['m1', 'm2'].map((id) => message({ id, labelIds: ['INBOX', 'UNREAD'] })),
    );
    await h.call('POST', '/api/mail/batch', { ids: ['m1', 'm2'], op: { kind: 'trash' } });
    const items = (await h.call('GET', '/api/journal')).body.items as { messageId: string }[];
    expect(items.map((e) => e.messageId).sort()).toEqual(['m1', 'm2']);
  });

  it('an undo adds no line, it dates the one undone', async () => {
    const h = await makeGmailHarness([message({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] })]);
    const res = await h.call('POST', '/api/mail/batch', { ids: ['m1'], op: { kind: 'trash' } });
    await h.call('POST', `/api/journal/${res.body[0].journalId}/undo`);
    const items = (await h.call('GET', '/api/journal')).body.items as { undoneAt: string | null }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.undoneAt).not.toBeNull();
  });
});

describe('stats/today', () => {
  const change = { id: 'm1', before: ['INBOX'], after: ['X'] };
  const log = (h: Awaited<ReturnType<typeof setup>>['h'], origin: 'rule' | 'ai', at: string) =>
    logAuto(h.db, change, origin, 'file', new Date(at));

  it('counts today by kind, ignores undone entries and other days', async () => {
    const { h } = await setup();
    // Now is 2 Nov 2026 08:00Z = 09:00 in Paris (UTC+1).
    log(h, 'rule', '2026-11-02T07:00:00.000Z');
    log(h, 'ai', '2026-11-02T07:30:00.000Z');
    const undone = log(h, 'ai', '2026-11-02T07:40:00.000Z');
    h.db.prepare('UPDATE journal SET undone_at = ? WHERE id = ?').run('2026-11-02T07:50:00.000Z', undone);
    log(h, 'ai', '2026-11-01T22:30:00.000Z'); // 23:30 in Paris yesterday
    const ins = h.db.prepare(
      "INSERT INTO journal (at, message_id, origin, action, before, after) VALUES (?, 'm1', 'user', ?, '[]', '[]')",
    );
    ins.run('2026-11-02T07:00:00.000Z', 'validate');
    ins.run('2026-11-02T07:01:00.000Z', 'validate');
    ins.run('2026-11-02T07:02:00.000Z', 'correct');
    ins.run('2026-11-02T07:03:00.000Z', 'archive');
    ins.run('2026-11-02T07:04:00.000Z', 'refuse');
    // The agent counts for its proposals only (validate, correct, refuse), not for its direct gestures.
    const pina = h.db.prepare(
      "INSERT INTO journal (at, message_id, origin, action, before, after) VALUES (?, 'm1', 'pina', ?, '[]', '[]')",
    );
    for (const a of ['file', 'archive', 'validate', 'correct', 'refuse'])
      pina.run('2026-11-02T07:05:00.000Z', a);
    const undonePina = pina.run('2026-11-02T07:06:00.000Z', 'refuse').lastInsertRowid;
    h.db.prepare('UPDATE journal SET undone_at = ? WHERE id = ?').run('2026-11-02T07:50:00.000Z', undonePina);
    const expected = { autoFiled: 2, ai: 1, rule: 1, validated: 2, corrected: 1, refused: 1, agent: 3 };
    expect(todayStats(h.db, h.clock())).toEqual(expected);
    expect((await h.call('GET', '/api/stats/today')).body).toEqual(expected);
  });

  it('23:30 in Paris is yesterday, in winter time (UTC+1)', () => {
    const now = new Date('2026-11-02T08:00:00.000Z');
    expect(parisDayStart(now).toISOString()).toBe('2026-11-01T23:00:00.000Z');
    expect(new Date('2026-11-01T22:30:00.000Z') < parisDayStart(now)).toBe(true);
  });

  it('23:30 in Paris is yesterday, in summer time (UTC+2)', () => {
    const now = new Date('2026-07-15T08:00:00.000Z');
    expect(parisDayStart(now).toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(new Date('2026-07-14T21:30:00.000Z') < parisDayStart(now)).toBe(true);
    expect(new Date('2026-07-14T22:30:00.000Z') < parisDayStart(now)).toBe(false);
  });

  it('handles the days when the clocks change', () => {
    expect(parisDayStart(new Date('2026-03-29T12:00:00.000Z')).toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(parisDayStart(new Date('2026-03-30T12:00:00.000Z')).toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    expect(parisDayStart(new Date('2026-10-25T12:00:00.000Z')).toISOString()).toBe(
      '2026-10-24T22:00:00.000Z',
    );
    expect(parisDayStart(new Date('2026-10-26T12:00:00.000Z')).toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });
});

async function pending(boxOf: (s: Awaited<ReturnType<typeof setup>>) => string | null = (s) => s.ecole) {
  const s = await setup();
  claim(s.h.db, 'm1', s.h.clock());
  saveProposal(s.h.db, {
    messageId: 'm1',
    boxId: boxOf(s),
    tagIds: [],
    importance: 'none',
    confidence: 50,
    source: 'ai',
    status: 'pending',
  });
  return s;
}
type S = Awaited<ReturnType<typeof pending>>;
const writes = (s: S) => s.h.calls.filter((c) => c.method !== 'GET').length;
const lines = (s: S) =>
  s.h.call('GET', '/api/journal').then((r) => r.body.items as Record<string, unknown>[]);

/** The deps with a Gmail that, at its first call, runs `first` (a gesture slipping in) and then answers. */
function gated(s: S, first: () => Promise<unknown>) {
  const google = s.h.deps.google;
  let done = false;
  const racing = Object.create(google) as typeof google;
  racing.request = (async (...args: Parameters<typeof google.request>) => {
    if (!done) {
      done = true;
      await first();
    }
    return google.request(...args);
  }) as typeof google.request;
  return { ...s.h.deps, google: racing };
}
const failing = (s: S) => gated(s, () => Promise.reject(new Error('Gmail is down')));
const LOCK = 'Un geste est déjà en cours sur ce mail';
const labelsOf = (s: S) => s.h.gmail.messages.get('m1')!.labelIds.sort();

describe('refuse a proposal', () => {
  const OLD = [
    'INSERT INTO examples (message_id, from_addr, from_domain, subject, box_id, tag_ids, at)',
    "VALUES ('m1','prof@ecole.fr','ecole.fr','Sujet m1','old','[]','2026-01-01T00:00:00.000Z')",
  ].join(' ');

  it('leaves the mail as it is, settles the proposal, writes no example and one line', async () => {
    const s = await pending();
    s.h.db.prepare(OLD).run();
    const example = getExample(s.h.db, 'm1');
    const before = writes(s);
    const res = await s.h.call('POST', '/api/mail/m1/refuse');
    expect(res.status).toBe(200);
    expect(typeof res.body.journalId).toBe('number');
    expect(writes(s)).toBe(before);
    expect(s.h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
    expect(getStoredMessage(s.h.db, 'm1')?.labels.sort()).toEqual(['INBOX', 'UNREAD']);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('refused');
    expect(getExample(s.h.db, 'm1')).toEqual(example);
    const [line, ...rest] = await lines(s);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ messageId: 'm1', origin: 'user', action: 'refuse' });
    expect(line!.before).toEqual(line!.after);
    expect(line!.before).toContain('INBOX');
    expect((await s.h.call('GET', '/api/mail?view=pending')).body.items).toEqual([]);
  });

  it('writes no example when there was none either', async () => {
    const s = await pending();
    await s.h.call('POST', '/api/mail/m1/refuse');
    expect(getExample(s.h.db, 'm1')).toBeNull();
  });

  it('answers 404 without a proposal and 409 for one already settled', async () => {
    const s = await setup();
    expect((await s.h.call('POST', '/api/mail/m1/refuse')).status).toBe(404);
    const p = await pending();
    await p.h.call('POST', '/api/mail/m1/validate');
    expect((await p.h.call('POST', '/api/mail/m1/refuse')).status).toBe(409);
  });

  it('refuses a proposal without a box too, with its line, and writes nothing to Gmail', async () => {
    const s = await pending(() => null);
    const before = writes(s);
    expect((await s.h.call('POST', '/api/mail/m1/refuse')).status).toBe(200);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('refused');
    expect((await lines(s)).map((l) => l.action)).toEqual(['refuse']);
    expect(writes(s)).toBe(before);
  });

  it.each([
    ['without INBOX', [] as string[], ['INBOX']],
    ['in the trash', ['TRASH'], [] as string[]],
    ['in the spam', ['SPAM'], [] as string[]],
  ])('answers 409 when Gmail says the mail is %s, though the cache says INBOX', async (_n, add, remove) => {
    const s = await pending();
    s.h.gmail.relabel('m1', add, remove);
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain('INBOX');
    const res = await s.h.call('POST', '/api/mail/m1/refuse');
    expect(res.status).toBe(409);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(await lines(s)).toEqual([]);
  });

  // A double click: a second refusal comes in while the first one reads Gmail; the lock stops it.
  it('answers 409 to a refusal slipped in during a refusal, which still passes', async () => {
    const s = await pending();
    let slipped: Awaited<ReturnType<typeof s.h.call>> | undefined;
    const deps = gated(s, async () => {
      slipped = await s.h.call('POST', '/api/mail/m1/refuse');
    });
    await expect(refuse(deps, 'm1')).resolves.toMatchObject({ status: 'refused' });
    expect(slipped?.status).toBe(409);
    expect(slipped?.body.error).toBe(LOCK);
    expect((await lines(s)).map((l) => l.action)).toEqual(['refuse']);
  });

  it('answers 409 when the proposal is settled while Gmail is read, and writes no line', async () => {
    const s = await pending();
    const deps = gated(s, async () => setProposalStatus(s.h.db, 'm1', 'refused'));
    await expect(refuse(deps, 'm1')).rejects.toBeInstanceOf(ConflictError);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('refused');
    expect(await lines(s)).toEqual([]);
  });

  it('undo puts the proposal back in the queue without touching Gmail', async () => {
    const s = await pending();
    const { body } = await s.h.call('POST', '/api/mail/m1/refuse');
    const before = writes(s);
    expect((await s.h.call('POST', `/api/journal/${body.journalId}/undo`)).status).toBe(200);
    expect(writes(s)).toBe(before);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(s.h.gmail.messages.get('m1')!.labelIds.sort()).toEqual(['INBOX', 'UNREAD']);
    expect((await s.h.call('GET', '/api/mail?view=pending')).body.items).toHaveLength(1);
  });
});

describe('one gesture at a time per mail', () => {
  it('answers 409 to a validation slipped in during a validation: one line, one write, one count', async () => {
    const s = await pending();
    const before = writes(s);
    let slipped: Awaited<ReturnType<typeof s.h.call>> | undefined;
    const deps = gated(s, async () => {
      slipped = await s.h.call('POST', '/api/mail/m1/validate');
    });
    await expect(validate(deps, 'm1')).resolves.toMatchObject({ status: 'accepted' });
    expect(slipped?.status).toBe(409);
    expect(slipped?.body.error).toBe(LOCK);
    expect((await lines(s)).map((l) => l.action)).toEqual(['validate']);
    expect(writes(s) - before).toBe(1);
    expect(labelsOf(s)).toEqual(['UNREAD', s.ecole].sort());
    expect((await s.h.call('GET', '/api/stats/today')).body).toMatchObject({ validated: 1, corrected: 0 });
    expect(getProposal(s.h.db, 'm1')?.status).toBe('accepted');
  });

  it('answers 409 to a correction slipped in during a correction: one line, the first box, no rule', async () => {
    const s = await pending();
    let slipped: Awaited<ReturnType<typeof s.h.call>> | undefined;
    const deps = gated(s, async () => {
      slipped = await s.h.call('POST', '/api/mail/m1/correct', {
        boxId: s.perso,
        tagIds: [],
        rememberSender: true,
      });
    });
    await expect(correct(deps, 'm1', s.ecole, [])).resolves.toMatchObject({ status: 'corrected' });
    expect(slipped?.status).toBe(409);
    expect(slipped?.body.error).toBe(LOCK);
    expect((await lines(s)).map((l) => l.action)).toEqual(['correct']);
    expect(labelsOf(s)).toEqual(['UNREAD', s.ecole].sort());
    expect((await s.h.call('GET', '/api/rules')).body.rules).toEqual([]);
    expect((await s.h.call('GET', '/api/stats/today')).body).toMatchObject({ corrected: 1, validated: 0 });
  });

  it('answers 409 to a correction then a refusal slipped in during a validation: nothing of theirs in Gmail', async () => {
    const s = await pending();
    const before = writes(s);
    const statuses: number[] = [];
    const deps = gated(s, async () => {
      statuses.push((await s.h.call('POST', '/api/mail/m1/correct', { boxId: s.perso, tagIds: [] })).status);
      statuses.push((await s.h.call('POST', '/api/mail/m1/refuse')).status);
    });
    await expect(validate(deps, 'm1')).resolves.toMatchObject({ status: 'accepted' });
    expect(statuses).toEqual([409, 409]);
    expect((await lines(s)).map((l) => l.action)).toEqual(['validate']);
    expect(writes(s) - before).toBe(1);
    expect(labelsOf(s)).toEqual(['UNREAD', s.ecole].sort());
  });

  it.each([
    ['validate', (s: S) => validate(failing(s), 'm1')],
    ['correct', (s: S) => correct(failing(s), 'm1', s.perso, [])],
  ])('writes nothing when Gmail fails during %s, and the next gesture passes', async (name, gesture) => {
    const s = await pending();
    await expect(gesture(s)).rejects.toThrow('Gmail is down');
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(await lines(s)).toEqual([]);
    expect((await s.h.call('GET', '/api/mail?view=pending')).body.items).toHaveLength(1);
    const again = name === 'validate' ? '/api/mail/m1/validate' : '/api/mail/m1/refuse';
    expect((await s.h.call('POST', again)).status).toBe(200);
  });

  it('still corrects a mail the AI filed alone (an auto proposal)', async () => {
    const s = await pending();
    saveProposal(s.h.db, {
      messageId: 'm1',
      boxId: s.ecole,
      tagIds: [],
      importance: 'none',
      confidence: 99,
      source: 'ai',
      status: 'auto',
    });
    const res = await s.h.call('POST', '/api/mail/m1/correct', { boxId: s.perso, tagIds: [] });
    expect(res.status).toBe(200);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('corrected');
    expect((await lines(s)).map((l) => l.action)).toEqual(['correct']);
  });

  it('does not hold a gesture on another mail', async () => {
    const s = await pending();
    s.h.gmail.deliver(message({ id: 'm2', labelIds: ['INBOX', 'UNREAD'] }));
    await s.h.sync();
    claim(s.h.db, 'm2', s.h.clock());
    saveProposal(s.h.db, {
      messageId: 'm2',
      boxId: s.perso,
      tagIds: [],
      importance: 'none',
      confidence: 50,
      source: 'ai',
      status: 'pending',
    });
    let other: Awaited<ReturnType<typeof s.h.call>> | undefined;
    const deps = gated(s, async () => {
      other = await s.h.call('POST', '/api/mail/m2/validate');
    });
    await expect(validate(deps, 'm1')).resolves.toMatchObject({ status: 'accepted' });
    expect(other?.status).toBe(200);
    expect((await lines(s)).map((l) => [l.messageId, l.action]).sort()).toEqual([
      ['m1', 'validate'],
      ['m2', 'validate'],
    ]);
  });
});
