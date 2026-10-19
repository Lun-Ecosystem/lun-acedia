import { afterEach, describe, expect, it } from 'vitest';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { getStoredMessage } from './store.ts';

type Harness = Awaited<ReturnType<typeof makeGmailHarness>>;
let current: Harness | undefined;

async function setup(...msgs: Parameters<typeof message>[0][]) {
  current = await makeGmailHarness(msgs.map(message));
  const ecole = current.gmail.addLabel('École');
  const perso = current.gmail.addLabel('Perso');
  current.db
    .prepare("INSERT INTO label_roles (label_id, role) VALUES (?, 'box'), (?, 'box')")
    .run(ecole, perso);
  return { h: current, ecole, perso };
}

// Acedia never deletes a mail for good: no DELETE request, in any test of this file.
afterEach(() => {
  expect(current?.calls.filter((c) => c.method === 'DELETE') ?? []).toEqual([]);
  current = undefined;
});

describe('mail actions', () => {
  it('files a mail into a box: adds the box, removes the inbox and any other box', async () => {
    const { h, ecole, perso } = await setup({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] });
    h.gmail.relabel('m1', [perso], []);
    await h.sync();
    const { status, body } = await h.call('POST', '/api/mail/m1/file', { boxId: ecole });
    expect(status).toBe(200);
    const modify = h.calls.find((c) => c.url.endsWith('/messages/m1/modify'))!;
    expect(JSON.parse(modify.body!)).toEqual({ addLabelIds: [ecole], removeLabelIds: ['INBOX', perso] });
    expect(body).toEqual({ id: 'm1', before: ['INBOX', 'UNREAD', perso], after: ['UNREAD', ecole] });
    expect(getStoredMessage(h.db, 'm1')?.labels).toEqual(['UNREAD', ecole]);
  });

  it('refuses to file into a label that is not a box', async () => {
    const { h } = await setup({ id: 'm1' });
    const { status } = await h.call('POST', '/api/mail/m1/file', { boxId: 'INBOX' });
    expect(status).toBe(400);
  });

  it('trashes with the trash endpoint, and untrashes', async () => {
    const { h } = await setup({ id: 'm1' });
    await h.call('POST', '/api/mail/m1/trash');
    expect(h.calls.some((c) => c.method === 'POST' && c.url.endsWith('/messages/m1/trash'))).toBe(true);
    expect(getStoredMessage(h.db, 'm1')?.labels).toContain('TRASH');
    await h.call('POST', '/api/mail/m1/untrash');
    expect(getStoredMessage(h.db, 'm1')?.labels).not.toContain('TRASH');
  });

  it('archives, reports spam, marks read and sets tags', async () => {
    const { h } = await setup({ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' });
    const urgent = h.gmail.addLabel('Urgent');
    await h.call('POST', '/api/mail/a/archive');
    expect(getStoredMessage(h.db, 'a')?.labels).toEqual(['UNREAD']);
    await h.call('POST', '/api/mail/b/spam');
    expect(getStoredMessage(h.db, 'b')?.labels).toEqual(expect.arrayContaining(['SPAM']));
    expect(getStoredMessage(h.db, 'b')?.labels).not.toContain('INBOX');
    await h.call('POST', '/api/mail/c/read', { read: true });
    expect(getStoredMessage(h.db, 'c')?.unread).toBe(false);
    await h.call('POST', '/api/mail/d/tags', { add: [urgent], remove: [] });
    expect(getStoredMessage(h.db, 'd')?.labels).toContain(urgent);
  });

  it('applies an action to several mails at once', async () => {
    const { h, ecole } = await setup({ id: 'a' }, { id: 'b' });
    const { status, body } = await h.call('POST', '/api/mail/batch', {
      ids: ['a', 'b'],
      op: { kind: 'file', boxId: ecole },
    });
    expect(status).toBe(200);
    expect(body.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
    expect(getStoredMessage(h.db, 'b')?.labels).toContain(ecole);
  });

  it('answers 404 for an unknown mail', async () => {
    const { h } = await setup({ id: 'm1' });
    expect((await h.call('POST', '/api/mail/absent/archive')).status).toBe(404);
  });

  it('shows the change in the inbox right away, before any sync', async () => {
    const { h } = await setup({ id: 'a' }, { id: 'b' });
    await h.call('POST', '/api/mail/a/archive');
    const inbox = await h.call('GET', '/api/mail?view=inbox');
    expect(inbox.body.items.map((m: { id: string }) => m.id)).toEqual(['b']);
  });
});
