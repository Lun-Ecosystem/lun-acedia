import { describe, expect, it } from 'vitest';
import { fileMail, trashMail } from '../gmail/actions.ts';
import { getStoredMessage } from '../gmail/store.ts';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { getExample } from './examples.ts';
import { logAuto, parisDayStart, todayStats } from './journal.ts';
import { getProposal } from './pipeline.ts';
import { claim, saveProposal } from './proposals.ts';

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
    expect(todayStats(h.db, h.clock())).toEqual({ autoFiled: 2, validated: 2, corrected: 1 });
    expect((await h.call('GET', '/api/stats/today')).body).toEqual({
      autoFiled: 2,
      validated: 2,
      corrected: 1,
    });
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
