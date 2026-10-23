import { describe, expect, it } from 'vitest';
import { b64url, multipart, textPart, type Part } from '../testing/fake-gmail.ts';
import { plainText, renderBody } from './body.ts';

const noAttachment = async () => {
  throw new Error('no attachment expected');
};
const CSP_PREFIX = '<meta http-equiv="Content-Security-Policy"';

describe('renderBody', () => {
  it('decodes an ISO-8859-1 HTML part', async () => {
    const part = textPart('text/html', Buffer.from('<p>Échéance du solde</p>', 'latin1'), 'ISO-8859-1');
    const { html } = await renderBody(part, noAttachment);
    expect(html).toContain('Échéance du solde');
  });

  it('decodes Windows-1252, euro sign included', async () => {
    const bytes = Buffer.concat([Buffer.from('<p>Total : 30 '), Buffer.from([0x80]), Buffer.from('</p>')]);
    const { html } = await renderBody(textPart('text/html', bytes, 'windows-1252'), noAttachment);
    expect(html).toContain('Total : 30 €');
  });

  it('prefers the HTML alternative over the text one', async () => {
    const part = multipart('multipart/alternative', [
      textPart('text/plain', 'version texte'),
      textPart('text/html', '<b>version html</b>'),
    ]);
    const { html } = await renderBody(part, noAttachment);
    expect(html).toContain('<b>version html</b>');
    expect(html).not.toContain('version texte');
  });

  it('inlines cid images as data URIs', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const image: Part = {
      mimeType: 'image/png',
      filename: 'logo.png',
      headers: [
        { name: 'Content-ID', value: '<logo@ecole>' },
        { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
      ],
      body: { size: png.length, data: b64url(png) },
    };
    const part = multipart('multipart/related', [textPart('text/html', '<img src="cid:logo@ecole">'), image]);
    const { html, attachments } = await renderBody(part, noAttachment);
    expect(html).toContain(`src="data:image/png;base64,${png.toString('base64')}"`);
    expect(attachments).toEqual([]);
  });

  it('loads a cid image stored as a separate attachment', async () => {
    const image: Part = {
      mimeType: 'image/gif',
      filename: 'pix.gif',
      headers: [{ name: 'Content-ID', value: '<pix>' }],
      body: { size: 3, attachmentId: 'att-1' },
    };
    const part = multipart('multipart/related', [textPart('text/html', '<img src="cid:pix">'), image]);
    const { html } = await renderBody(part, async (id) => (id === 'att-1' ? b64url('GIF') : ''));
    expect(html).toContain(`data:image/gif;base64,${Buffer.from('GIF').toString('base64')}`);
  });

  it('wraps plain text in an escaped pre', async () => {
    const { html } = await renderBody(textPart('text/plain', 'a <script>x</script> b'), noAttachment);
    expect(html).toContain('<pre style="white-space:pre-wrap">');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('starts with the CSP meta and opens links in a new tab', async () => {
    const { html } = await renderBody(textPart('text/html', '<p>x</p>'), noAttachment);
    expect(html.startsWith(CSP_PREFIX)).toBe(true);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<base target="_blank">');
  });

  it('lists real attachments with their metadata', async () => {
    const pdf: Part = {
      mimeType: 'application/pdf',
      filename: 'avis.pdf',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="avis.pdf"' }],
      body: { size: 12345, attachmentId: 'att-pdf' },
    };
    const part = multipart('multipart/mixed', [textPart('text/html', '<p>ci-joint</p>'), pdf]);
    const { attachments } = await renderBody(part, noAttachment);
    expect(attachments).toEqual([
      { id: 'att-pdf', filename: 'avis.pdf', mimeType: 'application/pdf', size: 12345 },
    ]);
  });

  it('decodes UTF-8 bytes that a part wrongly labels gb2312 (Outlook for Android)', async () => {
    const bytes = Buffer.from('<p>Envoyé à partir de</p>', 'utf8');
    const { html } = await renderBody(textPart('text/html', bytes, 'gb2312'), noAttachment);
    expect(html).toContain('Envoyé à partir de');
  });

  it('still decodes genuine gb2312 bytes', async () => {
    const bytes = Buffer.concat([
      Buffer.from('Envoy'),
      Buffer.from([0xa8, 0xa6, 0x20, 0xa8, 0xa4]),
      Buffer.from(' partir'),
    ]);
    const { html } = await renderBody(textPart('text/html', bytes, 'gb2312'), noAttachment);
    expect(html).toContain('Envoyé à partir');
  });

  it('falls back to UTF-8 on an unknown charset', async () => {
    const { html } = await renderBody(textPart('text/html', '<p>déjà</p>', 'x-unknown'), noAttachment);
    expect(html).toContain('déjà');
  });
});

describe('plainText', () => {
  it('prefers the text alternative', () => {
    const part = multipart('multipart/alternative', [
      textPart('text/plain', '  version texte \n'),
      textPart('text/html', '<b>version html</b>'),
    ]);
    expect(plainText(part)).toBe('version texte');
  });

  it('strips the HTML when there is no text part, and cuts at the limit', () => {
    const part = textPart(
      'text/html',
      '<style>p{color:red}</style><p>Rendu&nbsp;d&eacute;cal&#233; &amp; <b>noté</b></p>',
    );
    expect(plainText(part)).toBe('Rendu décalé & noté');
    expect(plainText(textPart('text/plain', 'x'.repeat(5000)))).toHaveLength(4000);
  });
});
