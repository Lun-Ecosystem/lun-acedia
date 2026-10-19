import { describe, expect, it } from 'vitest';
import { fileMail, trashMail } from '../gmail/actions.ts';
import { getStoredMessage } from '../gmail/store.ts';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { logAuto } from './journal.ts';

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
