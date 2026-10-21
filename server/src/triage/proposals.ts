import type { DatabaseSync } from 'node:sqlite';
import type { ProposalView } from '../types.ts';
import type { ImportanceLevel } from './classifier.ts';

export type ProposalStatus = ProposalView['status'];

export interface Proposal extends ProposalView {
  messageId: string;
  importance: ImportanceLevel;
  source: 'rule' | 'ai';
  createdAt: string;
}

interface Row {
  message_id: string;
  box_id: string | null;
  tag_ids: string;
  importance: ImportanceLevel;
  confidence: number;
  source: 'rule' | 'ai';
  reason: string | null;
  status: ProposalStatus | 'processing';
  created_at: string;
}

/**
 * Reserves a mail for the triage: true for the first caller only, so that a mail is classified once
 * even when two syncs hand it over at the same time. The row stays `processing` until `saveProposal`.
 */
export function claim(db: DatabaseSync, messageId: string, now: Date): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO proposals (message_id, tag_ids, importance, confidence, source, status, created_at)
       VALUES (?, '[]', 'none', 0, 'ai', 'processing', ?)`,
    )
    .run(messageId, now.toISOString());
  return info.changes > 0;
}

/** Gives the mail back (nothing could be decided): no proposal is shown. */
export function release(db: DatabaseSync, messageId: string): void {
  db.prepare("DELETE FROM proposals WHERE message_id = ? AND status = 'processing'").run(messageId);
}

export function saveProposal(
  db: DatabaseSync,
  p: Pick<Proposal, 'messageId' | 'boxId' | 'tagIds' | 'importance' | 'confidence' | 'source' | 'status'> & {
    reason?: string;
  },
): void {
  db.prepare(
    `UPDATE proposals SET box_id = ?, tag_ids = ?, importance = ?, confidence = ?, source = ?, status = ?, reason = ?
     WHERE message_id = ?`,
  ).run(
    p.boxId,
    JSON.stringify(p.tagIds),
    p.importance,
    p.confidence,
    p.source,
    p.status,
    p.reason ?? null,
    p.messageId,
  );
}

export function setProposalStatus(db: DatabaseSync, messageId: string, status: ProposalStatus): void {
  db.prepare("UPDATE proposals SET status = ? WHERE message_id = ? AND status != 'processing'").run(
    status,
    messageId,
  );
}

/** The proposal for a mail, once decided (a mail being classified has none yet). */
export function getProposal(db: DatabaseSync, messageId: string): Proposal | undefined {
  const row = db.prepare('SELECT * FROM proposals WHERE message_id = ?').get(messageId) as Row | undefined;
  if (!row || row.status === 'processing') return undefined;
  return {
    messageId: row.message_id,
    boxId: row.box_id,
    tagIds: JSON.parse(row.tag_ids) as string[],
    importance: row.importance,
    confidence: row.confidence,
    source: row.source,
    ...(row.reason ? { reason: row.reason } : {}),
    status: row.status,
    createdAt: row.created_at,
  };
}

/** What the mail list shows of a proposal. */
export function proposalView(p: Proposal): ProposalView {
  return {
    boxId: p.boxId,
    tagIds: p.tagIds,
    confidence: p.confidence,
    status: p.status,
    ...(p.reason ? { reason: p.reason } : {}),
  };
}
