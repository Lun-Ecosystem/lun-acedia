import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoogleClient, saveTokens } from '../google/client.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { b64url, FakeGmail, message, multipart, textPart } from '../testing/fake-gmail.ts';
import { makeHarness } from '../testing/harness.ts';
import { syncGmail } from './sync.ts';

const secretKey = randomBytes(32).toString('base64');
const config = { clientId: 'id', clientSecret: 's', redirectUri: 'http://localhost/cb' };

async function setup(gmail: FakeGmail) {
  const fake = fakeFetch(gmail.handler);
  const h = makeHarness({ google: { config, secretKey, fetch: fake.fetch } });
  saveTokens(h.db, secretKey, { accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' });
  const google = createGoogleClient({ db: h.db, fetch: fake.fetch, now: h.clock, config, secretKey });
  await syncGmail({ db: h.db, google, now: h.clock });
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

  it('lists a box by its label id', async () => {
    const gmail = new FakeGmail([message({ id: 'school', labelIds: ['Label_1'] }), message({ id: 'other' })]);
    const { get } = await setup(gmail);
    const { body } = await get('/api/mail?view=box:Label_1');
    expect(body.items.map((m: { id: string }) => m.id)).toEqual(['school']);
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
