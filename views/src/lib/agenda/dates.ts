import type { AgendaEvent, AgendaItem } from '../types.ts';

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

/** `agenda` is the planning: seven days from the cursor, as a list. */
export type Mode = 'day' | 'week' | 'month' | 'agenda';

/** What the editor works on: an existing item, or a new one of a kind on a day (at an hour). */
export type Editing = AgendaItem | { kind: 'event' | 'task'; day: Date; hour?: number };

/** The days shown for a mode around `cursor`: one, seven, or the six weeks covering the month. */
export function visibleDays(mode: Mode, cursor: Date): Date[] {
  if (mode === 'day') return [startOfDay(cursor)];
  // The planning starts on the day asked (today first, as a phone diary), the week on its Monday.
  const first =
    mode === 'month'
      ? startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1))
      : mode === 'agenda'
        ? startOfDay(cursor)
        : startOfWeek(cursor);
  return Array.from({ length: mode === 'month' ? 42 : 7 }, (_, i) => addDays(first, i));
}

export function step(mode: Mode, cursor: Date, direction: 1 | -1): Date {
  if (mode === 'day') return addDays(cursor, direction);
  if (mode === 'month') return new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1);
  return addDays(cursor, 7 * direction);
}

const fr = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('fr-FR', o);

export const dayName = (d: Date) => fr(d, { weekday: 'long', day: 'numeric', month: 'long' });
/** « mer. 21 oct. » */
export const shortDay = (d: Date) => fr(d, { weekday: 'short', day: 'numeric', month: 'short' });
/** « mer. » */
export const weekday = (d: Date) => fr(d, { weekday: 'short' });

/** Title of the period, lower case as French writes it: « 19 – 25 octobre 2026 ». */
export function title(mode: Mode, cursor: Date): string {
  if (mode === 'day') return fr(cursor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  // The planning names its month, as on a phone (« octobre 2026 »).
  if (mode === 'month' || mode === 'agenda') return fr(cursor, { month: 'long', year: 'numeric' });
  const from = startOfWeek(cursor);
  const to = addDays(from, 6);
  const sameYear = from.getFullYear() === to.getFullYear();
  if (sameYear && from.getMonth() === to.getMonth()) {
    return `${from.getDate()} – ${fr(to, { day: 'numeric', month: 'long', year: 'numeric' })}`;
  }
  const start = fr(
    from,
    sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' },
  );
  return `${start} – ${fr(to, { day: 'numeric', month: 'long', year: 'numeric' })}`;
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

/** Key of an item across calendars and lists: the same Google id can live in two calendars. */
export const itemKey = (item: AgendaItem) =>
  item.kind === 'event' ? `e:${item.calendarId}:${item.id}` : `t:${item.listId}:${item.id}`;

/** « 12:30 – 13:30 » */
export const hours = (e: AgendaEvent) => `${timeOf(e.start)} – ${timeOf(e.end)}`;

/** Minutes since local midnight of `day`, clipped to the day (0 to 1440): a DST day stays 24 h tall. */
function minuteIn(value: string, day: Date): number {
  const t = instant(value);
  if (t <= startOfDay(day).getTime()) return 0;
  if (t >= addDays(day, 1).getTime()) return 1440;
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

export interface Placed {
  event: AgendaEvent;
  /** Minutes from midnight. */
  top: number;
  bottom: number;
  /** Column of the event among those it overlaps, and how many columns they share. */
  lane: number;
  lanes: number;
}

/** The timed events of a day, overlapping ones side by side (as Google Agenda lays them). */
export function layoutDay(items: AgendaItem[], day: Date): Placed[] {
  const from = startOfDay(day).getTime();
  const to = addDays(day, 1).getTime();
  const placed: Placed[] = items
    .filter((i): i is AgendaEvent => i.kind === 'event' && !i.allDay)
    .filter((e) => instant(e.start) < to && instant(e.end) > from)
    .map((event) => ({
      event,
      top: minuteIn(event.start, day),
      bottom: minuteIn(event.end, day),
      lane: 0,
      lanes: 1,
    }))
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
  };
  for (const p of placed) {
    if (p.top >= clusterEnd && cluster.length) {
      close();
      cluster = [];
    }
    const ends: number[] = [];
    for (const q of cluster) ends[q.lane] = Math.max(ends[q.lane] ?? 0, q.bottom);
    const free = ends.findIndex((end) => end <= p.top);
    p.lane = free === -1 ? ends.length : free;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  if (cluster.length) close();
  return placed;
}

export interface Bar {
  event: AgendaEvent;
  /** First visible day (0 based), number of days covered, row in the band. */
  col: number;
  span: number;
  row: number;
}

/** The all-day events of the shown days, as bars over the days they cover, stacked in rows. */
export function allDayBars(items: AgendaItem[], days: Date[]): Bar[] {
  const rowsEnd: number[] = [];
  const bars: Bar[] = [];
  const events = items
    .filter((i): i is AgendaEvent => i.kind === 'event' && i.allDay)
    .sort((a, b) => instant(a.start) - instant(b.start) || instant(b.end) - instant(a.end));
  for (const event of events) {
    const covered = days
      .map((d, i) =>
        instant(event.start) < addDays(d, 1).getTime() && instant(event.end) > d.getTime() ? i : -1,
      )
      .filter((i) => i >= 0);
    if (!covered.length) continue;
    const col = covered[0]!;
    const span = covered.length;
    let row = rowsEnd.findIndex((end) => end <= col);
    if (row === -1) row = rowsEnd.length;
    rowsEnd[row] = col + span;
    bars.push({ event, col, span, row });
  }
  return bars;
}

/** « 30 min », « 1 h », « 1 h 30 », « 2 jours » */
function delay(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440} jour${minutes > 1440 ? 's' : ''}`;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 ? `${h} h ${minutes % 60}` : `${h} h`;
}

/** « Rappel 30 min avant », « Rappels 10 min et 1 h avant » */
export function remindersText(minutes: number[]): string {
  const list = [...minutes].sort((a, b) => a - b).map(delay);
  if (list.length === 1) return `Rappel ${list[0]} avant`;
  return `Rappels ${list.slice(0, -1).join(', ')} et ${list.at(-1)} avant`;
}

/** Short name of a reminder, for a chip: « 30 min avant ». */
export const reminderName = (minutes: number) => `${delay(minutes)} avant`;
