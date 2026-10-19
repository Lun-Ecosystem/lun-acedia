import type { DatabaseSync } from 'node:sqlite';
import {
  modifyLabels,
  NotFoundError,
  untrashMail,
  type ActionDeps,
  type LabelChange,
} from '../gmail/actions.ts';
import { getStoredMessage, setStoredLabels, upsertMessage } from '../gmail/store.ts';
import { fetchMetadata } from '../gmail/sync.ts';

export type Origin = 'rule' | 'ai';

export interface JournalEntry {
  id: number;
  at: string;
  messageId: string;
  subject: string;
  origin: Origin;
  action: string;
  before: string[];
  after: string[];
  undoneAt: string | null;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** Labels that change by just reading or by Gmail itself: they never block an undo. */
const VOLATILE = (label: string) =>
  label === 'UNREAD' || label === 'IMPORTANT' || label.startsWith('CATEGORY_');

const stable = (labels: string[]) => labels.filter((l) => !VOLATILE(l)).sort();
const same = (a: string[], b: string[]) => stable(a).join(',') === stable(b).join(',');

/** Records an automatic action (rule or AI) so that it can be listed and undone. */
export function logAuto(
  db: DatabaseSync,
  change: LabelChange,
  origin: Origin,
  action: string,
  now: Date,
): number {
  const info = db
    .prepare('INSERT INTO journal (at, message_id, origin, action, before, after) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      now.toISOString(),
      change.id,
      origin,
      action,
      JSON.stringify(change.before),
      JSON.stringify(change.after),
    );
  return Number(info.lastInsertRowid);
}

interface Row {
  id: number;
  at: string;
  message_id: string;
  origin: Origin;
  action: string;
  before: string;
  after: string;
  undone_at: string | null;
}

function toEntry(db: DatabaseSync, r: Row): JournalEntry {
  return {
    id: r.id,
    at: r.at,
    messageId: r.message_id,
    subject: getStoredMessage(db, r.message_id)?.subject ?? '',
    origin: r.origin,
    action: r.action,
    before: JSON.parse(r.before) as string[],
    after: JSON.parse(r.after) as string[],
    undoneAt: r.undone_at,
  };
}

export function listJournal(
  db: DatabaseSync,
  cursor?: number,
  limit = 50,
): { items: JournalEntry[]; cursor?: number } {
  const rows = db
    .prepare(`SELECT * FROM journal ${cursor ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(cursor ? [cursor] : []), limit + 1) as unknown as Row[];
  const page = rows.slice(0, limit);
  const result: { items: JournalEntry[]; cursor?: number } = { items: page.map((r) => toEntry(db, r)) };
  if (rows.length > limit) result.cursor = page.at(-1)!.id;
  return result;
}

/**
 * Puts the labels back as they were before the automatic action. Gmail is read first: if the mail
 * changed since (CrOliX filed it elsewhere), the undo is refused rather than erasing that gesture.
 */
export async function undo(deps: ActionDeps, journalId: number): Promise<LabelChange> {
  const row = deps.db.prepare('SELECT * FROM journal WHERE id = ?').get(journalId) as Row | undefined;
  if (!row) throw new NotFoundError('Entrée du journal introuvable');
  if (row.undone_at) throw new ConflictError('Action déjà annulée');
  const before = JSON.parse(row.before) as string[];
  const after = JSON.parse(row.after) as string[];

  const current = await fetchMetadata(deps.google, row.message_id);
  if (!current) throw new NotFoundError();
  upsertMessage(deps.db, current);
  let labels = current.labelIds ?? [];
  if (!same(labels, after)) throw new ConflictError('Le mail a changé depuis, annulation refusée');

  if (labels.includes('TRASH') && !before.includes('TRASH'))
    labels = (await untrashMail(deps, row.message_id)).after;
  const add = stable(before).filter((l) => !labels.includes(l));
  const remove = stable(labels).filter((l) => !before.includes(l));
  const change =
    add.length || remove.length ? await modifyLabels(deps, row.message_id, add, remove) : undefined;
  if (!change) setStoredLabels(deps.db, row.message_id, labels);
  deps.db.prepare('UPDATE journal SET undone_at = ? WHERE id = ?').run(deps.now().toISOString(), journalId);
  return { id: row.message_id, before: after, after: change?.after ?? labels };
}
