import { describe, expect, it } from 'vitest';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { buildMime, encodeHeader } from './compose.ts';

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('encodeHeader', () => {
  it('leaves ASCII alone and encodes accents as RFC 2047', () => {
    expect(encodeHeader('Hello')).toBe('Hello');
    expect(encodeHeader('Échéance')).toBe(`=?UTF-8?B?${Buffer.from('Échéance').toString('base64')}?=`);
  });
});

describe('buildMime', () => {
  it('writes the headers and both alternatives', () => {
    const mime = buildMime({
      from: 'Test <test@example.com>',
      to: 'prof@ecole.fr',
      subject: 'Re: Rendu décalé',
      html: '<p>Merci</p>',
      inReplyTo: '<abc@mail>',
      references: '<abc@mail>',
    });
    expect(mime).toContain('From: Test <test@example.com>');
    expect(mime).toContain('To: prof@ecole.fr');
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from('Re: Rendu décalé').toString('base64')}?=`);
    expect(mime).toContain('In-Reply-To: <abc@mail>');
    expect(mime).toContain('References: <abc@mail>');
    expect(mime).toContain('Content-Type: multipart/alternative');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
  });
});

describe('POST /api/mail/send', () => {
  it('sends from a known address', async () => {
    const h = await makeGmailHarness();
    const { status } = await h.call('POST', '/api/mail/send', {
      from: 'test@example.com',
      to: 'prof@ecole.fr',
      subject: 'Bonjour',
      html: '<p>Bonjour</p>',
    });
    expect(status).toBe(200);
    expect(h.gmail.sent).toHaveLength(1);
    expect(decodeRaw(h.gmail.sent[0]!.raw)).toContain('From: Test <test@example.com>');
  });

  it('refuses an address that is not a "send as" alias', async () => {
    const h = await makeGmailHarness();
    const { status, body } = await h.call('POST', '/api/mail/send', {
      from: 'someone@else.com',
      to: 'prof@ecole.fr',
      subject: 'x',
      html: 'x',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Envoyer en tant que/);
    expect(h.gmail.sent).toHaveLength(0);
  });

  it('keeps a reply in its thread', async () => {
    const h = await makeGmailHarness();
    await h.call('POST', '/api/mail/send', {
      from: 'test@example.com',
      to: 'prof@ecole.fr',
      subject: 'Re: x',
      html: 'ok',
      threadId: 't-1',
      inReplyTo: '<id@mail>',
    });
    expect(h.gmail.sent[0]!.threadId).toBe('t-1');
    expect(decodeRaw(h.gmail.sent[0]!.raw)).toContain('In-Reply-To: <id@mail>');
  });
});

describe('GET /api/send-as', () => {
  it('lists the aliases with the primary address as default', async () => {
    const h = await makeGmailHarness();
    const { body } = await h.call('GET', '/api/send-as');
    expect(body.addresses.map((a: { email: string }) => a.email)).toEqual([
      'test@example.com',
      'contact@lun.example',
    ]);
    expect(body.default).toBe('test@example.com');
  });

  it('answers a reply from the alias that received the mail', async () => {
    const h = await makeGmailHarness([message({ id: 'm1', to: "Lun'Ecosystem <contact@lun.example>" })]);
    const { body } = await h.call('GET', '/api/send-as?replyTo=m1');
    expect(body.default).toBe('contact@lun.example');
  });
});
