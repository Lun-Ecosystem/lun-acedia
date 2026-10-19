import type { AgendaItem } from '../types.ts';

/** Days are local: `AAAA-MM-JJ`, as Google Agenda shows them. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Weeks start on Monday. */
export function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}

export type Mode = 'day' | 'week' | 'month';

/** What the editor works on: an existing item, or a new one of a kind on a day. */
export type Editing = AgendaItem | { kind: 'event' | 'task'; day: Date };

/** The days shown for a mode around `cursor`: one, seven, or the six weeks covering the month. */
export function visibleDays(mode: Mode, cursor: Date): Date[] {
  if (mode === 'day') return [startOfDay(cursor)];
  const first =
    mode === 'week' ? startOfWeek(cursor) : startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  return Array.from({ length: mode === 'week' ? 7 : 42 }, (_, i) => addDays(first, i));
}

export function step(mode: Mode, cursor: Date, direction: 1 | -1): Date {
  if (mode === 'day') return addDays(cursor, direction);
  if (mode === 'week') return addDays(cursor, 7 * direction);
  return new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1);
}

const fr = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('fr-FR', o);

export const dayName = (d: Date) => fr(d, { weekday: 'long', day: 'numeric', month: 'long' });

export function title(mode: Mode, cursor: Date): string {
  if (mode === 'day') return fr(cursor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (mode === 'month') return fr(cursor, { month: 'long', year: 'numeric' });
  return `Semaine du ${fr(startOfWeek(cursor), { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

const instant = (value: string) => (value.length === 10 ? parseDay(value).getTime() : Date.parse(value));

/** The items of a day: events overlapping it (all-day ones first), then the tasks due that day. */
export function itemsOn(items: AgendaItem[], day: Date): AgendaItem[] {
  const from = startOfDay(day).getTime();
  const to = addDays(day, 1).getTime();
  const key = dayKey(day);
  const events = items
    .filter((i) => i.kind === 'event' && instant(i.start) < to && instant(i.end) > from)
    .sort((a, b) => {
      if (a.kind !== 'event' || b.kind !== 'event') return 0;
      return Number(b.allDay) - Number(a.allDay) || instant(a.start) - instant(b.start);
    });
  const tasks = items.filter((i) => i.kind === 'task' && i.due === key);
  return [...events, ...tasks];
}

export const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** `datetime-local` value (local time) of an ISO instant, and back. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export const fromLocalInput = (value: string) => new Date(value).toISOString();
