import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { getSetting, putSetting } from '../db.ts';
import type { ChatMessage } from '../llm/types.ts';
import { parisDayStart } from '../triage/journal.ts';

export type CardStatus = 'pending' | 'done' | 'refused' | 'failed' | 'expired';

export interface Card {
  id: number;
  day: string;
  /** Id of the user message that started the turn. */
  turn: number;
  createdAt: string;
  callId: string;
  action: string;
  input: unknown;
  effect: string;
  status: CardStatus;
  result: unknown;
  error: string | null;
  inverse: unknown;
  decidedAt: string | null;
}

/** The Paris calendar day (AAAA-MM-JJ) of an instant, from the same day start as the journal. */
export function dayOf(now: Date): string {
  // Noon after the day start is inside the same Paris day, whatever the clocks did.
  const inside = new Date(parisDayStart(now).getTime() + 12 * 3_600_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(inside);
}

export function appendMessage(db: DatabaseSync, day: string, message: ChatMessage, now: Date): number {
  const info = db
    .prepare('INSERT INTO pina_messages (day, at, role, body) VALUES (?, ?, ?, ?)')
    .run(day, now.toISOString(), message.role, JSON.stringify(message));
  return Number(info.lastInsertRowid);
}

export function messagesOf(
  db: DatabaseSync,
  day: string,
): { id: number; at: string; message: ChatMessage }[] {
  const rows = db.prepare('SELECT id, at, body FROM pina_messages WHERE day = ? ORDER BY id').all(day) as {
    id: number;
    at: string;
    body: string;
  }[];
  return rows.map((r) => ({ id: r.id, at: r.at, message: JSON.parse(r.body) as ChatMessage }));
}

const json = (v: string | null): unknown => (v === null ? null : JSON.parse(v));

function toCard(r: Record<string, unknown>): Card {
  return {
    id: r.id as number,
    day: r.day as string,
    turn: r.turn as number,
    createdAt: r.created_at as string,
    callId: r.call_id as string,
    action: r.action as string,
    input: json(r.input as string),
    effect: r.effect as string,
    status: r.status as CardStatus,
    result: json(r.result as string | null),
    error: r.error as string | null,
    inverse: json(r.inverse as string | null),
    decidedAt: r.decided_at as string | null,
  };
}

export function addCard(
  db: DatabaseSync,
  c: { day: string; turn: number; callId: string; action: string; input: unknown; effect: string; now: Date },
): number {
  const info = db
    .prepare(
      `INSERT INTO pina_cards (day, turn, created_at, call_id, action, input, effect, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(c.day, c.turn, c.now.toISOString(), c.callId, c.action, JSON.stringify(c.input), c.effect);
  return Number(info.lastInsertRowid);
}

export function getCard(db: DatabaseSync, id: number): Card | undefined {
  const r = db.prepare('SELECT * FROM pina_cards WHERE id = ?').get(id);
  return r ? toCard(r) : undefined;
}

/** Decides a card once: `false` when it is no longer pending (already decided, or expired). */
export function setCardStatus(
  db: DatabaseSync,
  id: number,
  from: 'pending',
  to: Exclude<CardStatus, 'pending'>,
  fields: { result?: unknown; error?: string; inverse?: unknown; at: Date },
): boolean {
  const info = db
    .prepare(
      `UPDATE pina_cards SET status = ?, result = ?, error = ?, inverse = ?, decided_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(
      to,
      fields.result === undefined ? null : JSON.stringify(fields.result),
      fields.error ?? null,
      fields.inverse === undefined ? null : JSON.stringify(fields.inverse),
      fields.at.toISOString(),
      id,
      from,
    );
  return info.changes > 0;
}

export function cardsOf(db: DatabaseSync, day: string): Card[] {
  return db.prepare('SELECT * FROM pina_cards WHERE day = ? ORDER BY id').all(day).map(toCard);
}

export function pendingCount(db: DatabaseSync, day: string): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM pina_cards WHERE day = ? AND status = 'pending'").get(day);
  return (r as { n: number }).n;
}

/** What still blocks the agent loop of a turn. */
export function pendingInTurn(db: DatabaseSync, turn: number): number {
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM pina_cards WHERE turn = ? AND status = 'pending'")
    .get(turn);
  return (r as { n: number }).n;
}

/** Cards of an earlier day can no longer be validated; `keep` are the cards being run right now. */
export function expireOld(db: DatabaseSync, today: string, keep: number[] = []): void {
  db.prepare(
    `UPDATE pina_cards SET status = 'expired' WHERE status = 'pending' AND day < ?
     AND id NOT IN (SELECT value FROM json_each(?))`,
  ).run(today, JSON.stringify(keep));
}

/** Drops the days older than `retentionDays` before `today` (a day string); today is always kept. */
export function purge(db: DatabaseSync, today: string, retentionDays: number): void {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - retentionDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  db.prepare('DELETE FROM pina_messages WHERE day < ?').run(cutoff);
  db.prepare('DELETE FROM pina_cards WHERE day < ?').run(cutoff);
}

export function days(db: DatabaseSync): { day: string; messages: number }[] {
  return db
    .prepare('SELECT day, COUNT(*) AS messages FROM pina_messages GROUP BY day ORDER BY day DESC')
    .all() as { day: string; messages: number }[];
}

export interface PinaSettings {
  mode: 'validate' | 'immediate';
  instructions: string;
  retentionDays: number;
  dailyCapUsd: number;
}

const DEFAULTS: PinaSettings = { mode: 'validate', instructions: '', retentionDays: 30, dailyCapUsd: 1 };

// Out-of-range input is rejected, not clamped.
const SettingsPatch = z
  .object({
    mode: z.enum(['validate', 'immediate']),
    instructions: z.string(),
    retentionDays: z.number().int().min(1).max(365),
    dailyCapUsd: z.number().min(0).max(50),
  })
  .partial()
  .strict();

/** Defaults are computed, never written. */
export function pinaSettings(db: DatabaseSync): PinaSettings {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof PinaSettings)[])
    (s as Record<string, unknown>)[k] = getSetting(db, `pina.${k}`, DEFAULTS[k]);
  return s;
}

export function putPinaSettings(db: DatabaseSync, patch: Partial<PinaSettings>): void {
  for (const [k, v] of Object.entries(SettingsPatch.parse(patch))) putSetting(db, `pina.${k}`, v);
}
