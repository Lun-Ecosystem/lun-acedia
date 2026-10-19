import type { DatabaseSync } from 'node:sqlite';
import { emitEvent } from '../contract/events.ts';
import type { SyncDeps } from '../gmail/sync.ts';
import type { AgendaItem } from '../types.ts';
import { eventsBetween, syncCalendars } from './calendar.ts';
import { syncTasks, tasksDueBetween } from './tasks.ts';
import { dayOf, toMs } from './time.ts';

export { undatedTasks } from './tasks.ts';

const startOf = (item: AgendaItem) => (item.kind === 'event' ? toMs(item.start) : toMs(item.due!));

/**
 * The events overlapping [from, to) and the tasks due in it, by start. `from` and `to` are days
 * (`AAAA-MM-JJ`, local) or ISO instants.
 */
export function agendaRange(db: DatabaseSync, from: string, to: string): AgendaItem[] {
  const fromMs = toMs(from);
  const toMsValue = toMs(to);
  const items: AgendaItem[] = [
    ...eventsBetween(db, fromMs, toMsValue),
    // A task due on a day is in the range when that day starts in it.
    ...tasksDueBetween(db, dayOf(new Date(fromMs)), dayOf(new Date(toMsValue - 1))).filter(
      (t) => startOf(t) >= fromMs && startOf(t) < toMsValue,
    ),
  ];
  return items.sort(
    (a, b) => startOf(a) - startOf(b) || (a.kind === b.kind ? 0 : a.kind === 'event' ? -1 : 1),
  );
}

/** Syncs Google Agenda and Google Tasks; emits `agenda.changed` when the cache changed. */
export async function syncAgenda(deps: SyncDeps): Promise<number> {
  const changes = (await syncCalendars(deps)) + (await syncTasks(deps));
  if (changes > 0) {
    emitEvent(
      deps.db,
      { type: 'agenda.changed', importance: 'info', title: 'Agenda mis à jour', data: { changes } },
      deps.now(),
    );
  }
  return changes;
}
