import type { DatabaseSync } from 'node:sqlite';
import type { Address } from '../types.ts';

/** A human gesture (validation, correction, manual filing) replayed to the AI as an example. */
export interface Example {
  from: string;
  subject: string;
  boxId: string;
  tagIds: string[];
}

interface MailLike {
  id: string;
  from: Address;
  subject: string;
}

const domainOf = (addr: string) => addr.split('@')[1]?.toLowerCase() ?? '';

/** Keeps the latest gesture for each mail. */
export function recordExample(
  db: DatabaseSync,
  mail: MailLike,
  boxId: string,
  tagIds: string[],
  at: Date,
): void {
  db.prepare(
    `INSERT INTO examples (message_id, from_addr, from_domain, subject, box_id, tag_ids, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET box_id = excluded.box_id, tag_ids = excluded.tag_ids, at = excluded.at`,
  ).run(
    mail.id,
    mail.from.addr.toLowerCase(),
    domainOf(mail.from.addr),
    mail.subject,
    boxId,
    JSON.stringify(tagIds),
    at.toISOString(),
  );
}

/** Same sender first, then same domain, then the most recent gestures. */
export function pickExamples(db: DatabaseSync, mail: MailLike, max = 8): Example[] {
  const rows = db
    .prepare(
      `SELECT from_addr, subject, box_id, tag_ids FROM examples
       ORDER BY (from_addr = ?) DESC, (from_domain = ?) DESC, at DESC LIMIT ?`,
    )
    .all(mail.from.addr.toLowerCase(), domainOf(mail.from.addr), max) as {
    from_addr: string;
    subject: string;
    box_id: string;
    tag_ids: string;
  }[];
  return rows.map((r) => ({
    from: r.from_addr,
    subject: r.subject,
    boxId: r.box_id,
    tagIds: JSON.parse(r.tag_ids) as string[],
  }));
}

/** The gesture kept for a mail, with its date; `null` when there is none. */
export function getExample(db: DatabaseSync, messageId: string): (Example & { at: string }) | null {
  const r = db
    .prepare('SELECT from_addr, subject, box_id, tag_ids, at FROM examples WHERE message_id = ?')
    .get(messageId) as
    { from_addr: string; subject: string; box_id: string; tag_ids: string; at: string } | undefined;
  if (!r) return null;
  return {
    from: r.from_addr,
    subject: r.subject,
    boxId: r.box_id,
    tagIds: JSON.parse(r.tag_ids) as string[],
    at: r.at,
  };
}

/** Puts back the gesture a mail had before (or none), as an undo needs. */
export function restoreExample(
  db: DatabaseSync,
  messageId: string,
  example: (Example & { at?: string }) | null,
  now: Date,
): void {
  if (!example) {
    db.prepare('DELETE FROM examples WHERE message_id = ?').run(messageId);
    return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO examples (message_id, from_addr, from_domain, subject, box_id, tag_ids, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    example.from,
    domainOf(example.from),
    example.subject,
    example.boxId,
    JSON.stringify(example.tagIds),
    example.at ?? now.toISOString(),
  );
}
