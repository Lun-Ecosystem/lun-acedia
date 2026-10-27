import { describe, expect, it } from 'vitest';
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
      to: 'prof@ecole.fr',
      subject: 'Re: Rendu décalé',
      text: 'Merci',
      replyTo: { id: '<abc@mail>', threadId: 't-1' },
    });
    expect(h.gmail.sent).toHaveLength(0);
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
});
