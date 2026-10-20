import type { DatabaseSync } from 'node:sqlite';
import { GoogleApiError, type GoogleClient } from '../google/client.ts';
import type { MailDetail, MailSummary } from '../types.ts';
import { renderBody, type GmailPart } from './body.ts';
import {
  getStoredMessage,
  getSyncState,
  header,
  listView,
  PAGE_SIZE,
  parseAddress,
  upsertMessage,
  viewFilter,
  viewQuery,
  type StoredMessage,
} from './store.ts';
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
  return { items: await cachedMessages(db, google, page.messages ?? []), cursor: page.nextPageToken };
}

/** The cached copy of each listed mail, fetched from Gmail (and cached) when missing. */
async function cachedMessages(
  db: DatabaseSync,
  google: GoogleClient,
  listed: { id: string }[],
): Promise<StoredMessage[]> {
  const items: StoredMessage[] = [];
  for (const { id } of listed) {
    let m = getStoredMessage(db, id);
    if (!m) {
      const meta = await fetchMetadata(google, id);
      if (!meta) continue;
      upsertMessage(db, meta);
      m = getStoredMessage(db, id);
    }
    if (m) items.push(m);
  }
  return items;
}

/** Where a page read from Gmail resumes: older than `before` (date, id), at Gmail's `token`. */
interface GmailCursor {
  before?: [number, string];
  token?: string;
}

// A cache cursor is plain base64url, which never contains a dot.
const GMAIL_CURSOR = 'g.';

function encodeGmailCursor(c: GmailCursor): string {
  return GMAIL_CURSOR + Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeGmailCursor(cursor: string): GmailCursor | undefined {
  if (!cursor.startsWith(GMAIL_CURSOR)) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor.slice(GMAIL_CURSOR.length), 'base64url').toString()) as GmailCursor;
  } catch {
    return undefined;
  }
}

async function gmailPage(
  db: DatabaseSync,
  google: GoogleClient,
  query: { labelIds?: string; q?: string },
  at: GmailCursor,
): Promise<{ items: StoredMessage[]; cursor?: string }> {
  const params = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
  if (query.labelIds) params.set('labelIds', query.labelIds);
  // `before:` counts in seconds: ask a second more, then keep only what is strictly older.
  const before = at.before;
  const q = [query.q, before && `before:${Math.floor(before[0] / 1000) + 1}`].filter(Boolean).join(' ');
  if (q) params.set('q', q);
  if (at.token) params.set('pageToken', at.token);
  const page = await google.request<{ messages?: { id: string }[]; nextPageToken?: string }>(
    'GET',
    `${GMAIL_API}/messages?${params}`,
  );
  const items = (await cachedMessages(db, google, page.messages ?? [])).filter((m) => {
    if (!before) return true;
    const date = Date.parse(m.date);
    return date < before[0] || (date === before[0] && m.id < before[1]);
  });
  const result: { items: StoredMessage[]; cursor?: string } = { items };
  if (page.nextPageToken) result.cursor = encodeGmailCursor({ ...at, token: page.nextPageToken });
  return result;
}

/**
 * A page of a view, newest first: from the cache, then from Gmail once the cache runs out, unless
 * the cache holds the whole mailbox. `undefined` for an unknown view.
 */
export async function listMail(
  db: DatabaseSync,
  google: GoogleClient,
  view: string,
  cursor?: string,
): Promise<{ items: StoredMessage[]; cursor?: string } | undefined> {
  const filter = viewFilter(view);
  if (!filter) return undefined;
  const query = viewQuery(view);
  const deep = cursor ? decodeGmailCursor(cursor) : undefined;
  if (deep) return query ? gmailPage(db, google, query, deep) : { items: [] };
  const page = listView(db, filter, cursor);
  if (page.cursor || !query || getSyncState(db, 'gmail.complete') === '1') return page;
  const last = page.items.at(-1);
  if (!last) return gmailPage(db, google, query, {});
  return { items: page.items, cursor: encodeGmailCursor({ before: [Date.parse(last.date), last.id] }) };
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
