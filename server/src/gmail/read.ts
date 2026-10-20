import type { DatabaseSync } from 'node:sqlite';
import { GoogleApiError, type GoogleClient } from '../google/client.ts';
import type { MailDetail, MailSummary } from '../types.ts';
import { renderBody, type GmailPart } from './body.ts';
import { getStoredMessage, header, parseAddress, upsertMessage, type StoredMessage } from './store.ts';
import { fetchMetadata, GMAIL_API } from './sync.ts';

export interface FullMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  payload: GmailPart;
}

/** What the API shows of a cached message (internal fields dropped). */
export function summary(m: StoredMessage): MailSummary {
  const s: MailSummary = {
    id: m.id,
    threadId: m.threadId,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date,
    unread: m.unread,
    labels: m.labels,
  };
  if (m.box) s.box = m.box;
  if (m.proposal) s.proposal = m.proposal;
  return s;
}

/** The whole message (`format=full`), or `undefined` when Gmail does not know it. */
export async function fetchFull(google: GoogleClient, id: string): Promise<FullMessage | undefined> {
  try {
    return await google.request<FullMessage>(
      'GET',
      `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
    );
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return undefined;
    throw err;
  }
}

/** A Gmail search (same syntax as in Gmail), 50 results per page; the results are cached. */
export async function searchMail(
  db: DatabaseSync,
  google: GoogleClient,
  q: string,
  cursor?: string,
): Promise<{ items: StoredMessage[]; cursor?: string | undefined }> {
  const params = new URLSearchParams({ q, maxResults: '50' });
  if (cursor) params.set('pageToken', cursor);
  const page = await google.request<{ messages?: { id: string }[]; nextPageToken?: string }>(
    'GET',
    `${GMAIL_API}/messages?${params}`,
  );
  const items: StoredMessage[] = [];
  for (const { id } of page.messages ?? []) {
    let m = getStoredMessage(db, id);
    if (!m) {
      const meta = await fetchMetadata(google, id);
      if (!meta) continue;
      upsertMessage(db, meta);
      m = getStoredMessage(db, id);
    }
    if (m) items.push(m);
  }
  return { items, cursor: page.nextPageToken };
}

/** Fetches a mail, refreshes its cache entry and renders it; `undefined` when it does not exist. */
export async function readMail(
  db: DatabaseSync,
  google: GoogleClient,
  id: string,
  decorate: (m: StoredMessage) => StoredMessage = (m) => m,
): Promise<{ detail: MailDetail; payload: GmailPart } | undefined> {
  const m = await fetchFull(google, id);
  if (!m) return undefined;
  upsertMessage(db, m);
  const stored = decorate(getStoredMessage(db, m.id)!);
  const { html, attachments } = await renderBody(m.payload, async (attachmentId) => {
    const att = await google.request<{ data: string }>(
      'GET',
      `${GMAIL_API}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return att.data;
  });
  const detail: MailDetail = {
    ...summary(stored),
    from: parseAddress(header(m, 'From')),
    to: header(m, 'To'),
    html,
    attachments,
  };
  const cc = header(m, 'Cc');
  if (cc) detail.cc = cc;
  return { detail, payload: m.payload };
}
