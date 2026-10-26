import type { DatabaseSync } from 'node:sqlite';
import {
  modifyLabels,
  NotFoundError,
  trashMail,
  untrashMail,
  type ActionDeps,
  type LabelChange,
} from '../gmail/actions.ts';
import { getStoredMessage, setStoredLabels, upsertMessage } from '../gmail/store.ts';
import { fetchMetadata } from '../gmail/sync.ts';
import type { Origin, JournalEntry, TodayStats } from '../types.ts';
import { restoreExample, type Example } from './examples.ts';
import { deleteRule } from './rules.ts';
import { setProposalStatus, type ProposalStatus } from './proposals.ts';

export type { Origin, JournalEntry };

export type UserAction = 'validate' | 'correct' | 'file' | 'archive' | 'trash' | 'spam';

/** The state an undo puts back besides the labels. */
export interface Previous {
  proposalStatus: ProposalStatus;
  example: (Example & { at?: string }) | null;
  /** The rule "remember this sender" created, removed again by the undo. */
  createdRuleId?: number;
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

/** Records a gesture of CrOliX; `previous` is what an undo restores besides the labels. */
export function logUser(
  db: DatabaseSync,
  change: LabelChange,
  action: UserAction,
  now: Date,
  previous?: Previous,
): number {
  const info = db
    .prepare(
      'INSERT INTO journal (at, message_id, origin, action, before, after, restore) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      now.toISOString(),
      change.id,
      'user',
      action,
      JSON.stringify(change.before),
      JSON.stringify(change.after),
      previous ? JSON.stringify(previous) : null,
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
  restore: string | null;
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
  else if (before.includes('TRASH') && !labels.includes('TRASH'))
    labels = (await trashMail(deps, row.message_id)).after;
  const add = stable(before).filter((l) => !labels.includes(l));
  const remove = stable(labels).filter((l) => !before.includes(l));
  const change =
    add.length || remove.length ? await modifyLabels(deps, row.message_id, add, remove) : undefined;
  if (!change) setStoredLabels(deps.db, row.message_id, labels);
  // The local writes go together: a failure leaves none of them.
  deps.db.exec('BEGIN');
  try {
    if (row.restore) {
      const previous = JSON.parse(row.restore) as Previous;
      setProposalStatus(deps.db, row.message_id, previous.proposalStatus);
      restoreExample(deps.db, row.message_id, previous.example, deps.now());
      if (previous.createdRuleId !== undefined) deleteRule(deps.db, previous.createdRuleId);
    }
    deps.db.prepare('UPDATE journal SET undone_at = ? WHERE id = ?').run(deps.now().toISOString(), journalId);
    deps.db.exec('COMMIT');
  } catch (err) {
    deps.db.exec('ROLLBACK');
    throw err;
  }
  return { id: row.message_id, before: after, after: change?.after ?? labels };
}

const PARIS = 'Europe/Paris';

/** Offset of Paris from UTC at an instant, in ms (DST included). */
function parisOffset(at: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: PARIS,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(at))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The instant at which the calendar day of `now`, in Paris, began. */
export function parisDayStart(now: Date): Date {
  const o = parisOffset(now.getTime());
  const local = new Date(now.getTime() + o);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // The offset can differ at midnight from the one at `now` (the clocks change at night).
  return new Date(midnight - parisOffset(midnight - o));
}

/** The first instant of the next calendar day in Paris. */
function parisDayEnd(now: Date): Date {
  const start = parisDayStart(now).getTime();
  // 36 h after a day start is always inside the next day, whatever the clocks did.
  return parisDayStart(new Date(start + 36 * 3_600_000));
}

/** What was done today (a Paris calendar day); undone entries do not count. */
export function todayStats(db: DatabaseSync, now: Date): TodayStats {
  const rows = db
    .prepare(
      `SELECT origin, action, COUNT(*) AS n FROM journal
       WHERE undone_at IS NULL AND at >= ? AND at < ? GROUP BY origin, action`,
    )
    .all(parisDayStart(now).toISOString(), parisDayEnd(now).toISOString()) as {
    origin: Origin;
    action: string;
    n: number;
  }[];
  const stats: TodayStats = { autoFiled: 0, validated: 0, corrected: 0 };
  for (const r of rows) {
    if (r.origin === 'user') {
      if (r.action === 'validate') stats.validated += r.n;
      if (r.action === 'correct') stats.corrected += r.n;
    } else stats.autoFiled += r.n;
  }
  return stats;
}
