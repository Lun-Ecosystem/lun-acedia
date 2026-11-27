import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoogleClient, saveTokens } from '../google/client.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { b64url, FakeGmail, message, multipart, textPart } from '../testing/fake-gmail.ts';
import { makeHarness } from '../testing/harness.ts';
import { setRole } from '../triage/labels.ts';
import { claim, saveProposal } from '../triage/proposals.ts';
import { getSyncState, PAGE_SIZE } from './store.ts';
import { syncGmail } from './sync.ts';

const secretKey = randomBytes(32).toString('base64');
const config = { clientId: 'id', clientSecret: 's', redirectUri: 'http://localhost/cb' };

async function setup(gmail: FakeGmail, opts: { initialMails?: number } = {}) {
  const fake = fakeFetch(gmail.handler);
  const h = makeHarness({ google: { config, secretKey, fetch: fake.fetch } });
  saveTokens(h.db, secretKey, { accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' });
  const google = createGoogleClient({ db: h.db, fetch: fake.fetch, now: h.clock, config, secretKey });
  await syncGmail({ db: h.db, google, now: h.clock, ...opts });
  const token = await h.pairClient();
  const get = async (path: string) => {
    const res = await h.app.request(path, { headers: h.auth(token) });
    return { status: res.status, body: await res.json() };
  };
  return { h, get, calls: fake.calls };
}

const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`;

describe('GET /api/mail', () => {
  it('lists the inbox only, newest first', async () => {
    const gmail = new FakeGmail([
      message({ id: 'old', date: at(1) }),
      message({ id: 'new', date: at(5) }),
      message({ id: 'archived', date: at(3), labelIds: [] }),
      message({ id: 'trashed', date: at(4), labelIds: ['TRASH'] }),
    ]);
    const { get } = await setup(gmail);
    const { body } = await get('/api/mail?view=inbox');
    expect(body.items.map((m: { id: string }) => m.id)).toEqual(['new', 'old']);
    expect(body.items[0]).toMatchObject({
      id: 'new',
      threadId: 't-new',
      from: { name: 'Prof Martin', addr: 'prof@ecole.fr' },
      subject: 'Sujet new',
      unread: true,
      date: at(5),
    });
  });

  it('lists the trash, the spam, the archive and the sent mails', async () => {
    const gmail = new FakeGmail([
      message({ id: 'inbox', date: at(1) }),
      message({ id: 'archived', date: at(2), labelIds: [] }),
      message({ id: 'trashed', date: at(3), labelIds: ['TRASH'] }),
      message({ id: 'spam', date: at(4), labelIds: ['SPAM'] }),
      message({ id: 'sent', date: at(5), labelIds: ['SENT'] }),
    ]);
    const { get } = await setup(gmail);
    const ids = async (view: string) =>
      (await get(`/api/mail?view=${view}`)).body.items.map((m: { id: string }) => m.id);
    expect(await ids('trash')).toEqual(['trashed']);
    expect(await ids('spam')).toEqual(['spam']);
    expect(await ids('archive')).toEqual(['archived']);
    expect(await ids('sent')).toEqual(['sent']);
    expect(await ids('pending')).toEqual([]);
  });

  it('keeps a mail of the trash or of the spam out of the inbox and the queue, even with INBOX', async () => {
    const gmail = new FakeGmail([
      message({ id: 'ok', date: at(1) }),
      message({ id: 'trashed', date: at(2), labelIds: ['INBOX', 'TRASH'] }),
      message({ id: 'spam', date: at(3), labelIds: ['INBOX', 'SPAM'] }),
    ]);
    const { h, get } = await setup(gmail);
    for (const id of ['ok', 'trashed', 'spam']) {
      claim(h.db, id, h.clock());
      saveProposal(h.db, {
        messageId: id,
        boxId: 'Label_1',
        tagIds: [],
        importance: 'none',
        confidence: 50,
        source: 'ai',
        status: 'pending',
      });
    }
    const ids = async (view: string) =>
      (await get(`/api/mail?view=${view}`)).body.items.map((m: { id: string }) => m.id);
    expect(await ids('inbox')).toEqual(['ok']);
    expect(await ids('pending')).toEqual(['ok']);
    expect(await ids('trash')).toEqual(['trashed']);
    expect(await ids('spam')).toEqual(['spam']);
  });

  it('lists a box by its label id', async () => {
    const gmail = new FakeGmail([message({ id: 'school', labelIds: ['Label_1'] }), message({ id: 'other' })]);
    const { get } = await setup(gmail);
    const { body } = await get('/api/mail?view=box:Label_1');
    expect(body.items.map((m: { id: string }) => m.id)).toEqual(['school']);
  });

  it('keeps paging a box past the cache, through Gmail', async () => {
    const gmail = new FakeGmail(
      [1, 2, 3, 4, 5].map((d) => message({ id: `b${d}`, labelIds: ['Label_1'], date: at(d) })),
    );
    const { get } = await setup(gmail, { initialMails: 2 });
    const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((m) => m.id);
    const first = await get('/api/mail?view=box:Label_1');
    expect(ids(first)).toEqual(['b5', 'b4']);
    const second = await get(`/api/mail?view=box:Label_1&cursor=${first.body.cursor}`);
    expect(ids(second)).toEqual(['b3', 'b2', 'b1']);
    expect(second.body.cursor).toBeUndefined();
  });

  it('paginates with a stable cursor, 50 per page', async () => {
    const mails = Array.from({ length: 60 }, (_, i) =>
      message({
        id: `m${String(i).padStart(2, '0')}`,
        date: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      }),
    );
    const { get } = await setup(new FakeGmail(mails));
    const first = await get('/api/mail?view=inbox');
    expect(first.body.items).toHaveLength(50);
    expect(first.body.cursor).toBeTruthy();
    const second = await get(`/api/mail?view=inbox&cursor=${encodeURIComponent(first.body.cursor)}`);
    expect(second.body.items).toHaveLength(10);
    expect(second.body.cursor).toBeUndefined();
    const all = [...first.body.items, ...second.body.items].map((m: { id: string }) => m.id);
    expect(new Set(all).size).toBe(60);
  });

  it('searches through Gmail', async () => {
    const gmail = new FakeGmail([
      message({ id: 'tax', subject: 'Avis d’imposition' }),
      message({ id: 'other', subject: 'Autre chose' }),
    ]);
    const { get } = await setup(gmail);
    const { body } = await get('/api/mail?q=imposition');
    expect(body.items.map((m: { id: string }) => m.id)).toEqual(['tax']);
  });

  it('rejects an unknown view', async () => {
    const { get } = await setup(new FakeGmail([]));
    expect((await get('/api/mail?view=nope')).status).toBe(400);
  });

  it('lists only the unread mails of a view under unread=1', async () => {
    const gmail = new FakeGmail([
      message({ id: 'unread', date: at(1) }),
      message({ id: 'read', date: at(2), labelIds: ['INBOX'] }),
      message({ id: 'box-unread', date: at(3), labelIds: ['Label_1', 'UNREAD'] }),
      message({ id: 'box-read', date: at(4), labelIds: ['Label_1'] }),
      message({ id: 'box-trashed', date: at(5), labelIds: ['Label_1', 'UNREAD', 'TRASH'] }),
    ]);
    const { get } = await setup(gmail);
    const ids = async (query: string) =>
      (await get(`/api/mail?${query}`)).body.items.map((m: { id: string }) => m.id);
    expect(await ids('view=inbox&unread=1')).toEqual(['unread']);
    expect(await ids('view=box:Label_1&unread=1')).toEqual(['box-unread']);
    expect(await ids('view=inbox')).toEqual(['read', 'unread']);
    expect(await ids('view=inbox&unread=0')).toEqual(['read', 'unread']);
  });

  it('shows under unread=1 an unread mail that sits past the first page of the view', async () => {
    const mails = Array.from({ length: PAGE_SIZE }, (_, i) =>
      message({
        id: `read${i}`,
        labelIds: ['INBOX'],
        date: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString(),
      }),
    );
    const { get } = await setup(new FakeGmail([...mails, message({ id: 'rank51', date: at(1) })]));
    const all = await get('/api/mail?view=inbox');
    expect(all.body.items.map((m: { id: string }) => m.id)).not.toContain('rank51');
    const unread = await get('/api/mail?view=inbox&unread=1');
    expect(unread.body.items.map((m: { id: string }) => m.id)).toEqual(['rank51']);
    expect(unread.body.cursor).toBeUndefined();
  });

  it('stops under unread=1 at the end of the cache, without asking Gmail, even when the cache is incomplete', async () => {
    const gmail = new FakeGmail([1, 2, 3, 4, 5].map((d) => message({ id: `m${d}`, date: at(d) })));
    const { h, get, calls } = await setup(gmail, { initialMails: 2 });
    expect(getSyncState(h.db, 'gmail.complete')).toBe('0');
    const asked = calls.length;
    const unread = await get('/api/mail?view=inbox&unread=1');
    expect(unread.body.items.map((m: { id: string }) => m.id)).toEqual(['m5', 'm4']);
    expect(unread.body.cursor).toBeUndefined();
    // A view with nothing unread in the cache: without the filter, it would be read from Gmail at once.
    expect((await get('/api/mail?view=sent&unread=1')).body).toEqual({ items: [] });
    expect(calls).toHaveLength(asked);
    expect((await get('/api/mail?view=inbox')).body.cursor).toBeTruthy();
  });

  it('paginates the unread mails with the cursor, 50 per page', async () => {
    const mails = Array.from({ length: 120 }, (_, i) =>
      message({
        id: `m${String(i).padStart(3, '0')}`,
        labelIds: i % 2 ? ['INBOX'] : ['INBOX', 'UNREAD'],
        date: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      }),
    );
    const { get } = await setup(new FakeGmail(mails));
    const first = await get('/api/mail?view=inbox&unread=1');
    expect(first.body.items).toHaveLength(50);
    expect(first.body.cursor).toBeTruthy();
    const second = await get(`/api/mail?view=inbox&unread=1&cursor=${encodeURIComponent(first.body.cursor)}`);
    expect(second.body.items).toHaveLength(10);
    expect(second.body.cursor).toBeUndefined();
    const all: { id: string; unread: boolean }[] = [...first.body.items, ...second.body.items];
    expect(new Set(all.map((m) => m.id)).size).toBe(60);
    expect(all.every((m) => m.unread)).toBe(true);
  });

  it('ignores unread=1 in a search', async () => {
    const gmail = new FakeGmail([message({ id: 'tax', subject: 'Avis d’imposition', labelIds: ['INBOX'] })]);
    const { get } = await setup(gmail);
    const { body } = await get('/api/mail?q=imposition&unread=1');
    expect(body.items.map((m: { id: string }) => m.id)).toEqual(['tax']);
  });
});

describe('GET /api/mail/counts', () => {
  it('counts the unread mails of the inbox and of each box, without the trash or the spam', async () => {
    const gmail = new FakeGmail();
    const [school, bank, tag, plain] = ['École', 'Banque', 'Urgent', 'Divers'].map((n) => gmail.addLabel(n));
    const mails: [string, string[]][] = [
      ['inbox-unread', ['INBOX', 'UNREAD']],
      ['inbox-read', ['INBOX']],
      ['inbox-trashed', ['INBOX', 'UNREAD', 'TRASH']],
      ['inbox-spam', ['INBOX', 'UNREAD', 'SPAM']],
      ['inbox-school', ['INBOX', 'UNREAD', school!]],
      ['school-unread', ['UNREAD', school!]],
      ['school-read', [school!]],
      ['school-trashed', ['UNREAD', 'TRASH', school!]],
      ['bank-read', [bank!]],
      ['tag-unread', ['UNREAD', tag!]],
      ['plain-unread', ['UNREAD', plain!]],
    ];
    for (const [id, labelIds] of mails) gmail.messages.set(id, message({ id, labelIds }));
    const { h, get } = await setup(gmail);
    setRole(h.db, school!, 'box');
    setRole(h.db, bank!, 'box');
    setRole(h.db, tag!, 'tag');
    const { status, body } = await get('/api/mail/counts');
    expect(status).toBe(200);
    // A box with no unread mail is absent.
    expect(body).toEqual({ inbox: 2, boxes: { [school!]: 2 } });
    const listed = async (view: string) => (await get(`/api/mail?view=${view}&unread=1`)).body.items.length;
    expect(await listed('inbox')).toBe(body.inbox);
    expect(await listed(`box:${school}`)).toBe(body.boxes[school!]);
    expect(await listed(`box:${bank}`)).toBe(0);
  });

  it('is not read as a mail named « counts »', async () => {
    const { get, calls } = await setup(new FakeGmail([]));
    const asked = calls.length;
    const { status, body } = await get('/api/mail/counts');
    expect(status).toBe(200);
    expect(body).toEqual({ inbox: 0, boxes: {} });
    expect(calls).toHaveLength(asked);
  });
});

describe('GET /api/mail/:id', () => {
  it('returns the rendered body and the headers', async () => {
    const payload = multipart('multipart/alternative', [
      textPart('text/plain', 'texte'),
      textPart('text/html', '<p>Le rendu est décalé</p>'),
    ]);
    const gmail = new FakeGmail([message({ id: 'm1', payload, to: 'moi@example.com' })]);
    const { get } = await setup(gmail);
    const { status, body } = await get('/api/mail/m1');
    expect(status).toBe(200);
    expect(body.subject).toBe('Sujet m1');
    expect(body.to).toBe('moi@example.com');
    expect(body.html).toContain('Le rendu est décalé');
    expect(body.attachments).toEqual([]);
  });

  it('answers 404 for an unknown mail', async () => {
    const { get } = await setup(new FakeGmail([]));
    expect((await get('/api/mail/absent')).status).toBe(404);
  });

  it('serves an attachment with its type', async () => {
    const pdf = {
      mimeType: 'application/pdf',
      filename: 'avis.pdf',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="avis.pdf"' }],
      body: { size: 4, attachmentId: 'att-1' },
    };
    const gmail = new FakeGmail([
      message({ id: 'm1', payload: multipart('multipart/mixed', [textPart('text/plain', 'x'), pdf]) }),
    ]);
    gmail.attachments.set('att-1', b64url('%PDF'));
    const { h } = await setup(gmail);
    const token = await h.pairClient('second');
    const detail = await (await h.app.request('/api/mail/m1', { headers: h.auth(token) })).json();
    expect(detail.attachments).toEqual([
      { id: '1', filename: 'avis.pdf', mimeType: 'application/pdf', size: 4 },
    ]);
    const res = await h.app.request(`/api/mail/m1/attachments/${detail.attachments[0].id}`, {
      headers: h.auth(token),
    });
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('avis.pdf');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF');
  });
});
