import { describe, expect, it } from 'vitest';
import { message, textPart } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { createDraft, deleteDraft, getDraft, sendDraft, updateDraft } from './drafts.ts';

const draft = {
  from: 'test@example.com',
  to: 'prof@ecole.fr',
  subject: 'Re: Rendu décalé',
  html: '<p>Merci</p>',
  text: 'Merci',
  threadId: 't-1',
  inReplyTo: '<abc@mail>',
};

describe('drafts', () => {
  it('createDraft posts users/me/drafts with the reply threadId', async () => {
    const h = await makeGmailHarness();
    const view = await createDraft(h.deps, draft);
    const post = h.calls.find((c) => c.method === 'POST' && c.url.endsWith('/users/me/drafts'));
    expect(JSON.parse(post!.body!).message.threadId).toBe('t-1');
    expect(view).toEqual({
      id: 'd1',
      from: 'test@example.com',
      to: 'prof@ecole.fr',
      subject: 'Re: Rendu décalé',
      text: 'Merci',
      replyTo: { id: '<abc@mail>', threadId: 't-1' },
    });
    expect(h.gmail.sent).toHaveLength(0);
  });

  // The composer saves back what it read: a draft read with its paragraphs merged would be sent so.
  it('a draft reads back whole, its paragraphs and length kept', async () => {
    const h = await makeGmailHarness();
    const text = `Salut Camille,\n\nMercredi, c’est parfait.\n\n${'Suite. '.repeat(700)}\n\nNatsume`;
    const { id } = await createDraft(h.deps, { ...draft, text, html: '<p>x</p>' });
    expect((await getDraft(h.deps, id)).text).toBe(text.trim().replace(/ \n/g, '\n'));
  });

  it('a draft says its sender, the alias it was written from', async () => {
    const h = await makeGmailHarness();
    const { id } = await createDraft(h.deps, { ...draft, from: "Lun'Ecosystem <contact@lun.example>" });
    expect((await getDraft(h.deps, id)).from).toBe('contact@lun.example');
  });

  it('updates, reads and deletes a draft', async () => {
    const h = await makeGmailHarness();
    const { id } = await createDraft(h.deps, draft);
    await updateDraft(h.deps, id, { ...draft, text: 'Autre', html: '<p>Autre</p>', cc: 'x@y.fr' });
    expect(await getDraft(h.deps, id)).toMatchObject({ text: 'Autre', cc: 'x@y.fr' });
    await deleteDraft(h.deps, id);
    await expect(getDraft(h.deps, id)).rejects.toThrow(/introuvable/);
  });

  it('sendDraft posts drafts/send and records the sent mail like /send', async () => {
    const h = await makeGmailHarness();
    const { id } = await createDraft(h.deps, draft);
    const sent = await sendDraft(h.deps, id);
    expect(sent).toMatchObject({ id: 'sent-1', threadId: 't-1' });
    expect(h.gmail.sent).toHaveLength(1);
    expect(h.calls.some((c) => c.method === 'POST' && c.url.endsWith('/drafts/send'))).toBe(true);
  });

  it('serves the screen routes', async () => {
    const h = await makeGmailHarness();
    const created = await h.call('POST', '/api/drafts', draft);
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect((await h.call('GET', `/api/drafts/${id}`)).body.subject).toBe('Re: Rendu décalé');
    expect((await h.call('PUT', `/api/drafts/${id}`, { ...draft, subject: 'Autre' })).body.subject).toBe(
      'Autre',
    );
    expect((await h.call('POST', `/api/drafts/${id}/send`)).status).toBe(200);
    expect((await h.call('GET', `/api/drafts/${id}`)).status).toBe(404);
    expect((await h.call('DELETE', '/api/drafts/nope')).status).toBe(404);
  });

  it('draft.create from the catalog only prepares a draft', async () => {
    const h = await makeGmailHarness();
    const res = await h.call('POST', '/lun/v1/actions/draft.create', {
      to: 'prof@ecole.fr',
      subject: 'Hello',
      text: 'Bonjour',
    });
    expect(res.status).toBe(200);
    expect(h.gmail.drafts.size).toBe(1);
    expect(h.gmail.sent).toHaveLength(0);
  });

  it('draft.create with replyTo threads the draft, from the alias that received the mail', async () => {
    const original = message({
      id: 'm1',
      to: "Lun'Ecosystem <contact@lun.example>",
      payload: {
        ...textPart('text/plain', 'Bonjour'),
        headers: [
          { name: 'Message-ID', value: '<abc@mail>' },
          { name: 'References', value: '<old@mail>' },
        ],
      },
    });
    const h = await makeGmailHarness([original]);
    const res = await h.call('POST', '/lun/v1/actions/draft.create', {
      to: 'prof@ecole.fr',
      subject: 'Re: Sujet',
      text: 'Merci',
      replyTo: 'm1',
    });
    expect(res.status).toBe(200);
    const raw = [...h.gmail.drafts.values()][0]!;
    expect(raw.threadId).toBe('t-m1');
    const mime = Buffer.from(raw.raw, 'base64url').toString('utf8');
    expect(mime).toContain('In-Reply-To: <abc@mail>');
    expect(mime).toContain('References: <old@mail> <abc@mail>');
    expect(mime).toContain('<contact@lun.example>');
  });

  it('draft.update without replyTo keeps the alias the draft was written from', async () => {
    const h = await makeGmailHarness();
    const { id } = await createDraft(h.deps, { ...draft, from: "Lun'Ecosystem <contact@lun.example>" });
    const res = await h.call('POST', '/lun/v1/actions/draft.update', {
      id,
      to: 'a@b.fr',
      subject: 's',
      text: 't',
    });
    expect(res.status).toBe(200);
    expect((await getDraft(h.deps, id)).from).toBe('contact@lun.example');
  });

  it('draft.create with an unknown replyTo is not found, not a 500', async () => {
    const h = await makeGmailHarness();
    const res = await h.call('POST', '/lun/v1/actions/draft.create', {
      to: 'a@b.fr',
      subject: 's',
      text: 't',
      replyTo: 'nope',
    });
    expect(res.body.ok).toBe(false);
    expect(h.gmail.drafts.size).toBe(0);
  });

  it('rejects a line break in a header value, on the routes and the action', async () => {
    const h = await makeGmailHarness();
    const to = 'a@b.fr\r\nBcc: x@example.org';
    expect((await h.call('POST', '/api/drafts', { ...draft, to })).status).toBe(400);
    expect((await h.call('POST', '/api/mail/send', { ...draft, to })).status).toBe(400);
    const res = await h.call('POST', '/lun/v1/actions/draft.create', { to, subject: 's', text: 't' });
    expect(res.status).toBe(400);
    expect(h.gmail.drafts.size).toBe(0);
    expect(h.gmail.sent).toHaveLength(0);
  });
});
