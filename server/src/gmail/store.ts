import type { DatabaseSync } from 'node:sqlite';
import type { Address, MailSummary } from '../types.ts';

/** A message as Gmail's `format=metadata` (or `full`) returns it. */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  payload?: { mimeType?: string; headers?: { name: string; value: string }[] };
}

export interface StoredMessage extends MailSummary {
  to: string;
  hasAttachments: boolean;
}

interface Row {
  id: string;
  thread_id: string;
  label_ids: string;
  from_addr: string;
  from_name: string | null;
  to_addrs: string;
  subject: string;
  snippet: string;
  internal_date: number;
  unread: number;
  has_attachments: number;
}

export function header(m: { payload?: GmailMessage['payload'] }, name: string): string {
  const lower = name.toLowerCase();
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

/** `"Prof Martin" <prof@ecole.fr>` → `{ name: 'Prof Martin', addr: 'prof@ecole.fr' }`. */
export function parseAddress(value: string): Address {
  const match = value.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (match) {
    const name = match[1]?.trim();
    return name ? { name, addr: match[2]!.trim() } : { addr: match[2]!.trim() };
  }
  return { addr: value.trim() };
}

function toSummary(row: Row): StoredMessage {
  const from: Address = row.from_name
    ? { name: row.from_name, addr: row.from_addr }
    : { addr: row.from_addr };
  return {
    id: row.id,
    threadId: row.thread_id,
    from,
    to: row.to_addrs,
    subject: row.subject,
    snippet: row.snippet,
    date: new Date(row.internal_date).toISOString(),
    unread: row.unread === 1,
    labels: JSON.parse(row.label_ids) as string[],
    hasAttachments: row.has_attachments === 1,
  };
}

export function upsertMessage(db: DatabaseSync, m: GmailMessage): void {
  const labels = m.labelIds ?? [];
  const from = parseAddress(header(m, 'From'));
  db.prepare(
    `INSERT INTO messages (id, thread_id, label_ids, from_addr, from_name, to_addrs, subject, snippet,
       internal_date, unread, has_attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id, label_ids = excluded.label_ids,
       from_addr = excluded.from_addr, from_name = excluded.from_name, to_addrs = excluded.to_addrs,
       subject = excluded.subject, snippet = excluded.snippet, internal_date = excluded.internal_date,
       unread = excluded.unread, has_attachments = excluded.has_attachments`,
  ).run(
    m.id,
    m.threadId,
    JSON.stringify(labels),
    from.addr,
    from.name ?? null,
    header(m, 'To'),
    header(m, 'Subject'),
    m.snippet ?? '',
    Number(m.internalDate),
    labels.includes('UNREAD') ? 1 : 0,
    m.payload?.mimeType === 'multipart/mixed' ? 1 : 0,
  );
}

/** Updates the cached labels right after Acedia changed them in Gmail. */
export function setStoredLabels(db: DatabaseSync, id: string, labels: string[]): void {
  db.prepare('UPDATE messages SET label_ids = ?, unread = ? WHERE id = ?').run(
    JSON.stringify(labels),
    labels.includes('UNREAD') ? 1 : 0,
    id,
  );
}

export function removeMessage(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

export function getStoredMessage(db: DatabaseSync, id: string): StoredMessage | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
  return row ? toSummary(row) : undefined;
}

export function storedIds(db: DatabaseSync): Set<string> {
  return new Set((db.prepare('SELECT id FROM messages').all() as { id: string }[]).map((r) => r.id));
}

export function messageCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
}

export const PAGE_SIZE = 50;

const has = (label: string) => `EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = '${label}')`;

/** SQL condition and parameters for each view of the mailbox. */
export function viewFilter(view: string): { where: string; params: string[] } | undefined {
  switch (view) {
    case 'inbox':
      return { where: has('INBOX'), params: [] };
    case 'trash':
      return { where: has('TRASH'), params: [] };
    case 'spam':
      return { where: has('SPAM'), params: [] };
    case 'sent':
      return { where: `${has('SENT')} AND NOT ${has('TRASH')}`, params: [] };
    case 'drafts':
      return { where: has('DRAFT'), params: [] };
    case 'archive':
      return {
        where: ['INBOX', 'TRASH', 'SPAM', 'DRAFT', 'SENT'].map((l) => `NOT ${has(l)}`).join(' AND '),
        params: [],
      };
    default:
      if (view.startsWith('box:') && view.length > 4) {
        return {
          where: `EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = ?) AND NOT ${has('TRASH')}`,
          params: [view.slice(4)],
        };
      }
      return undefined;
  }
}

function encodeCursor(row: { internal_date: number; id: string }): string {
  return Buffer.from(`${row.internal_date}:${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): [number, string] | undefined {
  const raw = Buffer.from(cursor, 'base64url').toString();
  const sep = raw.indexOf(':');
  if (sep < 0) return undefined;
  const date = Number(raw.slice(0, sep));
  return Number.isFinite(date) ? [date, raw.slice(sep + 1)] : undefined;
}

/** A page of a view, newest first; the cursor is the last row's (date, id). */
export function listView(
  db: DatabaseSync,
  filter: { where: string; params: string[] },
  cursor?: string,
): { items: StoredMessage[]; cursor?: string } {
  const after = cursor ? decodeCursor(cursor) : undefined;
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE ${filter.where}
       ${after ? 'AND (internal_date, id) < (?, ?)' : ''}
       ORDER BY internal_date DESC, id DESC LIMIT ?`,
    )
    .all(...filter.params, ...(after ?? []), PAGE_SIZE + 1) as unknown as Row[];
  const page = rows.slice(0, PAGE_SIZE);
  const result: { items: StoredMessage[]; cursor?: string } = { items: page.map(toSummary) };
  if (rows.length > PAGE_SIZE) result.cursor = encodeCursor(page.at(-1)!);
  return result;
}

export function getSyncState(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function setSyncState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function saveLabels(db: DatabaseSync, labels: { id: string; name: string; type: string }[]): void {
  db.exec('DELETE FROM labels');
  const insert = db.prepare('INSERT INTO labels (id, name, type) VALUES (?, ?, ?)');
  for (const l of labels) insert.run(l.id, l.name, l.type);
}
