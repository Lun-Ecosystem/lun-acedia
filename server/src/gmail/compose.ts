import { randomBytes } from 'node:crypto';
import type { GoogleClient } from '../google/client.ts';
import { BadRequestError, type ActionDeps } from './actions.ts';
import { getStoredMessage, parseAddress } from './store.ts';
import { GMAIL_API } from './sync.ts';

export interface Draft {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export interface SendAsAddress {
  email: string;
  name?: string;
  primary: boolean;
}

/** RFC 2047: non-ASCII header values travel as base64 UTF-8 encoded words. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function base64Lines(text: string): string {
  return (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  );
}

/** A multipart/alternative message (text then HTML), UTF-8, base64 bodies. */
export function buildMime(draft: Omit<Draft, 'threadId'>): string {
  const boundary = `acedia-${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${draft.from}`,
    `To: ${draft.to}`,
    ...(draft.cc ? [`Cc: ${draft.cc}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`] : []),
    ...(draft.references ? [`References: ${draft.references}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, content: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(content),
    ].join('\r\n');
  return [
    ...headers,
    '',
    part('text/plain', draft.text ?? htmlToText(draft.html)),
    part('text/html', draft.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export async function listSendAs(google: GoogleClient): Promise<SendAsAddress[]> {
  const { sendAs } = await google.request<{
    sendAs: { sendAsEmail: string; displayName?: string; isPrimary?: boolean }[];
  }>('GET', `${GMAIL_API}/settings/sendAs`);
  return sendAs.map((s) => {
    const a: SendAsAddress = { email: s.sendAsEmail, primary: Boolean(s.isPrimary) };
    if (s.displayName) a.name = s.displayName;
    return a;
  });
}

/** The address a reply goes out from: the alias that received the mail, otherwise the primary one. */
export function replyFrom(addresses: SendAsAddress[], receivedOn: string): string {
  const recipients = receivedOn
    .split(',')
    .map((r) => parseAddress(r).addr.toLowerCase())
    .filter(Boolean);
  const alias = addresses.find((a) => recipients.includes(a.email.toLowerCase()));
  return (alias ?? addresses.find((a) => a.primary) ?? addresses[0])?.email ?? '';
}

export async function defaultFrom(
  deps: ActionDeps,
  replyTo?: string,
): Promise<{ addresses: SendAsAddress[]; default: string }> {
  const addresses = await listSendAs(deps.google);
  const original = replyTo ? getStoredMessage(deps.db, replyTo) : undefined;
  return { addresses, default: replyFrom(addresses, original?.to ?? '') };
}

/** Sends a mail; `from` must be one of the "Send mail as" addresses of the account. */
export async function sendMail(deps: ActionDeps, draft: Draft): Promise<{ id: string; threadId: string }> {
  const addresses = await listSendAs(deps.google);
  const wanted = parseAddress(draft.from).addr.toLowerCase();
  const sender = addresses.find((a) => a.email.toLowerCase() === wanted);
  if (!sender)
    throw new BadRequestError(`« ${draft.from} » ne fait pas partie des adresses « Envoyer en tant que »`);
  const from = sender.name ? `${encodeHeader(sender.name)} <${sender.email}>` : sender.email;
  const raw = Buffer.from(buildMime({ ...draft, from }), 'utf8').toString('base64url');
  const body: { raw: string; threadId?: string } = { raw };
  if (draft.threadId) body.threadId = draft.threadId;
  return deps.google.request('POST', `${GMAIL_API}/messages/send`, body);
}
