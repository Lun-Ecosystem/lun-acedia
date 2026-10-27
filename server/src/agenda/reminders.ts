import type { DatabaseSync } from 'node:sqlite';
import { emitEvent } from '../contract/events.ts';
import { eventsStartingBetween } from './calendar.ts';
import { tasksDueBetween } from './tasks.ts';
import { dayOf, toMs } from './time.ts';

/** A reminder older than this is dropped (the server was off): better silent than late. */
const LATE_MS = 15 * 60_000;
/** Google Agenda accepts reminders up to four weeks before. */
const MAX_LEAD_MS = 40_320 * 60_000;
/** Google Tasks does not expose its reminders: a task is recalled at 09:00 on its due day. */
const TASK_HOUR = 9;

export interface Reminder {
  /** Unique per occurrence: a moved event is recalled again. */
  key: string;
  kind: 'event' | 'task';
  itemId: string;
  /** Calendar or task list. */
  containerId: string;
  title: string;
  /** When the reminder is due (ISO). */
  at: string;
  /** Minutes before the start (events only). */
  minutes?: number;
}

const sent = (db: DatabaseSync, key: string) =>
  db.prepare('SELECT 1 FROM reminders_sent WHERE key = ?').get(key) !== undefined;

/** The reminders due at `now` that were not emitted yet. */
export function dueReminders(db: DatabaseSync, now: Date): Reminder[] {
  const t = now.getTime();
  const due = (at: number) => at <= t && at > t - LATE_MS;
  const result: Reminder[] = [];

  for (const e of eventsStartingBetween(db, t - LATE_MS, t + MAX_LEAD_MS)) {
    const start = toMs(e.start);
    for (const minutes of new Set(e.reminders)) {
      const at = start - minutes * 60_000;
      if (!due(at)) continue;
      result.push({
        key: `event:${e.calendarId}:${e.id}:${start}:${minutes}`,
        kind: 'event',
        itemId: e.id,
        containerId: e.calendarId,
        title: e.title,
        at: new Date(at).toISOString(),
        minutes,
      });
    }
  }

  const today = dayOf(now);
  for (const task of tasksDueBetween(db, today, today)) {
    const at = toMs(today) + TASK_HOUR * 3600_000;
    if (task.done || !due(at)) continue;
    result.push({
      key: `task:${task.listId}:${task.id}:${today}`,
      kind: 'task',
      itemId: task.id,
      containerId: task.listId,
      title: task.title,
      at: new Date(at).toISOString(),
    });
  }
  return result.filter((r) => !sent(db, r.key));
}

function phrase(r: Reminder): string {
  if (r.kind === 'task') return `${r.title} : à faire aujourd’hui`;
  if (!r.minutes) return `${r.title} commence maintenant`;
  if (r.minutes % 1440 === 0) return `${r.title} dans ${r.minutes / 1440} j`;
  if (r.minutes % 60 === 0) return `${r.title} dans ${r.minutes / 60} h`;
  return `${r.title} dans ${r.minutes} min`;
}

/** Emits each due reminder once (`agenda.reminder`, `normal`); returns how many were emitted. */
export function runReminders(db: DatabaseSync, now: Date): number {
  const due = dueReminders(db, now);
  for (const r of due) {
    db.prepare('INSERT OR IGNORE INTO reminders_sent (key, at) VALUES (?, ?)').run(r.key, now.toISOString());
    const data: Record<string, unknown> = { kind: r.kind, id: r.itemId, at: r.at };
    data[r.kind === 'event' ? 'calendarId' : 'listId'] = r.containerId;
    if (r.minutes !== undefined) data.minutes = r.minutes;
    emitEvent(db, { type: 'agenda.reminder', importance: 'urgent', title: phrase(r), data }, now);
  }
  return due.length;
}

/** Checks the reminders every minute; forgets the emitted ones after 30 days. */
export function startReminderLoop(db: DatabaseSync, clock: () => Date): { stop: () => void } {
  const timer = setInterval(() => {
    const now = clock();
    runReminders(db, now);
    db.prepare('DELETE FROM reminders_sent WHERE at < ?').run(
      new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    );
  }, 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
