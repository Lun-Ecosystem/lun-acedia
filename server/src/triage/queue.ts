import type { DatabaseSync } from 'node:sqlite';

/** Unusable answers or failures tolerated for one mail before it is left to be filed by hand. */
export const MAX_ATTEMPTS = 3;

/**
 * Mails waiting for the triage. The sync queues every new incoming mail in the same step as it
 * caches it; a mail leaves the queue only once decided (or no longer in the inbox), so a restart, a
 * pause, a credit outage or a transient error never loses one.
 */
export function enqueue(db: DatabaseSync, ids: string[], now: Date): void {
  const insert = db.prepare('INSERT OR IGNORE INTO triage_queue (message_id, queued_at) VALUES (?, ?)');
  for (const id of ids) insert.run(id, now.toISOString());
}

/** The queued mails, oldest first. */
export function queuedIds(db: DatabaseSync): string[] {
  return (
    db.prepare('SELECT message_id FROM triage_queue ORDER BY queued_at, rowid').all() as {
      message_id: string;
    }[]
  ).map((r) => r.message_id);
}

export function dequeue(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM triage_queue WHERE message_id = ?').run(id);
}

/** Counts a failed attempt; past `MAX_ATTEMPTS` the mail leaves the queue. */
export function failedAttempt(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE triage_queue SET attempts = attempts + 1 WHERE message_id = ?').run(id);
  db.prepare('DELETE FROM triage_queue WHERE message_id = ? AND attempts >= ?').run(id, MAX_ATTEMPTS);
}

/** At start-up: claims left by a process that died mid-triage are given back. */
export function recoverQueue(db: DatabaseSync): void {
  db.prepare("DELETE FROM proposals WHERE status = 'processing'").run();
}
