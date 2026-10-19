import type { DatabaseSync } from 'node:sqlite';
import { NotFoundError } from '../gmail/actions.ts';
import { getSyncState, setSyncState } from '../gmail/store.ts';
import type { SyncDeps } from '../gmail/sync.ts';
import { GoogleApiError } from '../google/client.ts';
import type { AgendaEvent } from '../types.ts';
import { isDay, toMs } from './time.ts';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const DAY_MS = 24 * 3600_000;

interface GoogleReminder {
  method: string;
  minutes: number;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  reminders?: { useDefault?: boolean; overrides?: GoogleReminder[] };
}

interface CalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  selected?: boolean;
  defaultReminders?: GoogleReminder[];
}

interface Row {
  calendar_id: string;
  id: string;
  title: string;
  start: string;
  end: string;
  start_ms: number;
  end_ms: number;
  all_day: number;
  location: string | null;
  reminders: string | null;
}

const popups = (reminders: GoogleReminder[] | undefined) =>
  (reminders ?? []).filter((r) => r.method === 'popup').map((r) => r.minutes);

const eventsUrl = (calendarId: string) =>
  `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

function defaultReminders(db: DatabaseSync, calendarId: string): number[] {
  const row = db.prepare('SELECT default_reminders FROM calendars WHERE id = ?').get(calendarId) as
    { default_reminders: string } | undefined;
  return row ? (JSON.parse(row.default_reminders) as number[]) : [];
}

export function toEvent(db: DatabaseSync, r: Row): AgendaEvent {
  const e: AgendaEvent = {
    kind: 'event',
    id: r.id,
    calendarId: r.calendar_id,
    title: r.title,
    start: r.start,
    end: r.end,
    allDay: r.all_day === 1,
    reminders:
      r.reminders === null ? defaultReminders(db, r.calendar_id) : (JSON.parse(r.reminders) as number[]),
  };
  if (r.location) e.location = r.location;
  return e;
}

export function getEvent(db: DatabaseSync, calendarId: string, id: string): AgendaEvent | undefined {
  const row = db
    .prepare('SELECT * FROM calendar_events WHERE calendar_id = ? AND id = ?')
    .get(calendarId, id) as Row | undefined;
  return row ? toEvent(db, row) : undefined;
}

/** Cached events overlapping [fromMs, toMs). */
export function eventsBetween(db: DatabaseSync, fromMs: number, toMs: number): AgendaEvent[] {
  const rows = db
    .prepare('SELECT * FROM calendar_events WHERE start_ms < ? AND end_ms > ? ORDER BY start_ms, title')
    .all(toMs, fromMs) as unknown as Row[];
  return rows.map((r) => toEvent(db, r));
}

/** Events starting in [fromMs, toMs], for the reminders. */
export function eventsStartingBetween(db: DatabaseSync, fromMs: number, toMs: number): AgendaEvent[] {
  const rows = db
    .prepare('SELECT * FROM calendar_events WHERE start_ms >= ? AND start_ms <= ?')
    .all(fromMs, toMs) as unknown as Row[];
  return rows.map((r) => toEvent(db, r));
}

const instant = (value: string) => new Date(value).toISOString();

/** Stores an event as Google returns it; true when the cache changed. */
function upsertEvent(db: DatabaseSync, calendarId: string, e: GoogleEvent): boolean {
  const allDay = !e.start?.dateTime;
  const start = allDay ? (e.start?.date ?? '') : instant(e.start!.dateTime!);
  const end = allDay ? (e.end?.date ?? start) : instant(e.end?.dateTime ?? e.start!.dateTime!);
  const own =
    e.reminders && e.reminders.useDefault === false ? JSON.stringify(popups(e.reminders.overrides)) : null;
  const values = [
    e.summary ?? '(sans titre)',
    start,
    end,
    toMs(start),
    Math.max(toMs(end), toMs(start) + (allDay ? DAY_MS : 0)),
    allDay ? 1 : 0,
    e.location ?? null,
    own,
  ] as const;
  const before = db
    .prepare(
      'SELECT title, start, end, start_ms, end_ms, all_day, location, reminders FROM calendar_events WHERE calendar_id = ? AND id = ?',
    )
    .get(calendarId, e.id);
  db.prepare(
    `INSERT INTO calendar_events (calendar_id, id, title, start, end, start_ms, end_ms, all_day, location, reminders)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(calendar_id, id) DO UPDATE SET title = excluded.title, start = excluded.start, end = excluded.end,
       start_ms = excluded.start_ms, end_ms = excluded.end_ms, all_day = excluded.all_day,
       location = excluded.location, reminders = excluded.reminders`,
  ).run(calendarId, e.id, ...values);
  return JSON.stringify(before ? Object.values(before) : null) !== JSON.stringify(values);
}

function removeEvent(db: DatabaseSync, calendarId: string, id: string): boolean {
  return (
    db.prepare('DELETE FROM calendar_events WHERE calendar_id = ? AND id = ?').run(calendarId, id).changes > 0
  );
}

function forgetCalendar(db: DatabaseSync, calendarId: string): number {
  db.prepare('DELETE FROM sync_state WHERE key = ?').run(`cal:${calendarId}`);
  return Number(db.prepare('DELETE FROM calendar_events WHERE calendar_id = ?').run(calendarId).changes);
}

/**
 * Pulls one calendar: incremental with the stored sync token, otherwise the whole window
 * (−30 days, +365 days), after which the events Google did not return are dropped.
 */
async function pullCalendar(deps: SyncDeps, calendarId: string, token: string | undefined): Promise<number> {
  const now = deps.now().getTime();
  const seen = new Set<string>();
  let changes = 0;
  let pageToken: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
    if (token) params.set('syncToken', token);
    else {
      params.set('timeMin', new Date(now - 30 * DAY_MS).toISOString());
      params.set('timeMax', new Date(now + 365 * DAY_MS).toISOString());
    }
    if (pageToken) params.set('pageToken', pageToken);
    const page = await deps.google.request<{
      items?: GoogleEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    }>('GET', `${eventsUrl(calendarId)}?${params}`);
    for (const e of page.items ?? []) {
      seen.add(e.id);
      if (e.status === 'cancelled') changes += removeEvent(deps.db, calendarId, e.id) ? 1 : 0;
      else changes += upsertEvent(deps.db, calendarId, e) ? 1 : 0;
    }
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    if (page.nextSyncToken) setSyncState(deps.db, `cal:${calendarId}`, page.nextSyncToken);
    break;
  }
  if (!token) {
    const stale = (
      deps.db.prepare('SELECT id FROM calendar_events WHERE calendar_id = ?').all(calendarId) as {
        id: string;
      }[]
    ).filter((r) => !seen.has(r.id));
    for (const { id } of stale) changes += removeEvent(deps.db, calendarId, id) ? 1 : 0;
  }
  return changes;
}

/** Syncs the calendars shown in Google Agenda; returns how many cached events changed. */
export async function syncCalendars(deps: SyncDeps): Promise<number> {
  const entries: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const page = await deps.google.request<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
      'GET',
      `${CALENDAR_API}/users/me/calendarList${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`,
    );
    entries.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const selected = entries.filter((c) => c.selected);
  let changes = 0;
  const known = (deps.db.prepare('SELECT id FROM calendars').all() as { id: string }[]).map((r) => r.id);
  for (const id of known.filter((id) => !selected.some((c) => c.id === id))) {
    deps.db.prepare('DELETE FROM calendars WHERE id = ?').run(id);
    changes += forgetCalendar(deps.db, id);
  }
  for (const c of selected) {
    deps.db
      .prepare(
        `INSERT INTO calendars (id, title, default_reminders) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, default_reminders = excluded.default_reminders`,
      )
      .run(c.id, c.summaryOverride ?? c.summary ?? c.id, JSON.stringify(popups(c.defaultReminders)));
    const token = getSyncState(deps.db, `cal:${c.id}`);
    try {
      changes += await pullCalendar(deps, c.id, token);
    } catch (err) {
      // 410: Google forgot the sync token; start again from the full window.
      if (!(err instanceof GoogleApiError && err.status === 410) || !token) throw err;
      deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(`cal:${c.id}`);
      changes += await pullCalendar(deps, c.id, undefined);
    }
  }
  return changes;
}

export function listCalendars(db: DatabaseSync): { id: string; title: string }[] {
  return db.prepare('SELECT id, title FROM calendars ORDER BY title').all() as {
    id: string;
    title: string;
  }[];
}

export interface EventInput {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** Minutes before the start; `null` for the calendar defaults. */
  reminders?: number[] | null;
}

function toGoogle(input: Partial<EventInput>, allDay: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const when = (value: string) =>
    allDay ? { date: isDay(value) ? value : value.slice(0, 10) } : { dateTime: value };
  if (input.title !== undefined) out.summary = input.title;
  if (input.location !== undefined) out.location = input.location;
  if (input.start !== undefined) out.start = when(input.start);
  if (input.end !== undefined) out.end = when(input.end);
  if (input.reminders !== undefined)
    out.reminders =
      input.reminders === null
        ? { useDefault: true }
        : { useDefault: false, overrides: input.reminders.map((minutes) => ({ method: 'popup', minutes })) };
  return out;
}

async function write(
  deps: SyncDeps,
  method: string,
  url: string,
  body?: unknown,
): Promise<GoogleEvent | undefined> {
  try {
    return await deps.google.request<GoogleEvent | undefined>(method, url, body);
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) throw new NotFoundError('Événement introuvable');
    throw err;
  }
}

export async function createEvent(
  deps: SyncDeps,
  calendarId: string,
  input: EventInput,
): Promise<AgendaEvent> {
  const e = (await write(deps, 'POST', eventsUrl(calendarId), toGoogle(input, input.allDay)))!;
  upsertEvent(deps.db, calendarId, e);
  return getEvent(deps.db, calendarId, e.id)!;
}

export async function updateEvent(
  deps: SyncDeps,
  calendarId: string,
  id: string,
  patch: Partial<EventInput>,
): Promise<AgendaEvent> {
  const allDay = patch.allDay ?? getEvent(deps.db, calendarId, id)?.allDay ?? false;
  const url = `${eventsUrl(calendarId)}/${encodeURIComponent(id)}`;
  const e = (await write(deps, 'PATCH', url, toGoogle(patch, allDay)))!;
  upsertEvent(deps.db, calendarId, e);
  return getEvent(deps.db, calendarId, e.id)!;
}

export async function deleteEvent(deps: SyncDeps, calendarId: string, id: string): Promise<void> {
  await write(deps, 'DELETE', `${eventsUrl(calendarId)}/${encodeURIComponent(id)}`);
  removeEvent(deps.db, calendarId, id);
}
