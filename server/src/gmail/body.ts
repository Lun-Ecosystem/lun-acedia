import type { AttachmentMeta } from '../types.ts';

/** A MIME part as the Gmail API returns it with `format=full`. */
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

const MAX_INLINE_BYTES = 2 * 1024 * 1024;

/**
 * Prefixed to every rendered mail: no script, no connection except images, fonts and styles, links in
 * a new tab. The view still shows it in a sandboxed iframe.
 */
const PREAMBLE =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data:; ` +
  `style-src * 'unsafe-inline'; font-src * data:">` +
  '<base target="_blank">';

function partHeader(part: GmailPart, name: string): string {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

function charsetOf(part: GmailPart): string {
  return partHeader(part, 'Content-Type').match(/charset="?([^";\s]+)"?/i)?.[1] ?? 'utf-8';
}

/**
 * Windows-1252 code points for bytes 0x80–0x9F. Browsers decode ISO-8859-1, latin1 and US-ASCII as
 * Windows-1252 too, but Node's TextDecoder maps these bytes to C1 controls: `€`, `’`, `œ` would vanish.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
  0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a,
  0x153, 0x9d, 0x17e, 0x178,
];
const CP1252_LABELS = new Set([
  'windows-1252',
  'cp1252',
  'iso-8859-1',
  'iso8859-1',
  'latin1',
  'us-ascii',
  'ascii',
]);

function decodeText(part: GmailPart): string {
  const bytes = Buffer.from(part.body?.data ?? '', 'base64url');
  const charset = charsetOf(part).toLowerCase();
  if (CP1252_LABELS.has(charset)) {
    return Array.from(bytes, (b) =>
      String.fromCharCode(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b),
    ).join('');
  }
  // Outlook for Android labels UTF-8 bytes gb2312: valid non-ASCII UTF-8 is almost never real legacy text.
  if (charset !== 'utf-8' && charset !== 'utf8' && bytes.some((b) => b >= 0x80)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      /* not UTF-8: keep the declared charset */
    }
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function walk(part: GmailPart, visit: (p: GmailPart) => void): void {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function findBody(part: GmailPart, mimeType: string): GmailPart | undefined {
  let found: GmailPart | undefined;
  walk(part, (p) => {
    if (!found && p.mimeType === mimeType && !p.filename && p.body?.data !== undefined) found = p;
  });
  return found;
}

/**
 * Turns a Gmail payload into displayable HTML: the HTML alternative when there is one, otherwise the
 * text escaped in a `<pre>`; text decoded in its declared charset; `cid:` images inlined.
 */
export async function renderBody(
  payload: GmailPart,
  loadAttachment: (attachmentId: string) => Promise<string>,
): Promise<{ html: string; attachments: AttachmentMeta[] }> {
  const htmlPart = findBody(payload, 'text/html');
  const textPart = htmlPart ? undefined : findBody(payload, 'text/plain');
  let html = htmlPart
    ? decodeText(htmlPart)
    : `<pre style="white-space:pre-wrap">${escapeHtml(textPart ? decodeText(textPart) : '')}</pre>`;

  const attachments: AttachmentMeta[] = [];
  const inline: { cid: string; part: GmailPart }[] = [];
  walk(payload, (p) => {
    const cid = partHeader(p, 'Content-ID').replace(/^<|>$/g, '');
    if (cid && p.mimeType?.startsWith('image/')) inline.push({ cid, part: p });
    else if (p.filename) {
      attachments.push({
        id: p.partId ?? p.body?.attachmentId ?? p.filename,
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        size: p.body?.size ?? 0,
      });
    }
  });

  for (const { cid, part } of inline) {
    if ((part.body?.size ?? 0) > MAX_INLINE_BYTES) continue;
    const data =
      part.body?.data ?? (part.body?.attachmentId ? await loadAttachment(part.body.attachmentId) : undefined);
    if (!data) continue;
    const uri = `data:${part.mimeType};base64,${Buffer.from(data, 'base64url').toString('base64')}`;
    html = html.split(`cid:${cid}`).join(uri);
  }

  return { html: PREAMBLE + html, attachments };
}

/** Finds a part by its id (the stable identifier exposed as `AttachmentMeta.id`). */
export function findPart(payload: GmailPart, id: string): GmailPart | undefined {
  let found: GmailPart | undefined;
  walk(payload, (p) => {
    if (!found && (p.partId === id || (!p.partId && p.body?.attachmentId === id))) found = p;
  });
  return found;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  euro: '€',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  icirc: 'î',
  iuml: 'ï',
  ocirc: 'ô',
  ugrave: 'ù',
  ucirc: 'û',
  Eacute: 'É',
  Egrave: 'È',
  Agrave: 'À',
  Ccedil: 'Ç',
};

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex: string, n: string) =>
      String.fromCodePoint(parseInt(n, hex ? 16 : 10)),
    )
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name] ?? all);
}

/** The readable text of a mail (text part, else the HTML stripped), for the AI: at most `max` characters. */
export function plainText(payload: GmailPart, max = 4000): string {
  const textPart = findBody(payload, 'text/plain');
  const htmlPart = textPart ? undefined : findBody(payload, 'text/html');
  const raw = textPart ? decodeText(textPart) : htmlPart ? htmlToText(decodeText(htmlPart)) : '';
  return raw
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, max);
}
