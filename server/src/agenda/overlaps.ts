import type { DatabaseSync } from 'node:sqlite';
import { emitEvent } from '../contract/events.ts';
import { getState } from '../contract/state.ts';
import { withdrawCard } from '../pina/agent.ts';
import { addCard, dayOf } from '../pina/store.ts';
import { parisOffset } from '../triage/journal.ts';
import { mainCalendar } from './calendar.ts';

/*
 * The agenda's real conflicts, found in the cache without the model, each said by a card of turn 0 that waits
 * for CrOliX whatever the agent's mode: a move of the event that is theirs alone to the first free slot of
 * the same day after the conflict, or a card that only signals it.
 */

const PREFIX = 'chevauchement:';
const DAY_MS = 86_400_000;
const HORIZON_MS = 7 * DAY_MS;
const QUARTER_MS = 15 * 60_000;
const MAX_PER_DAY = 3;
// A fixed day, in Paris, every day of the week: an evening or a week-end conflict is a conflict.
const FIRST_MIN = 8 * 60;
const LAST_MIN = 22 * 60;

interface Row {
  calendar_id: string;
  id: string;
  title: string;
  start_ms: number;
  end_ms: number;
  solo: number;
  series_id: string | null;
}

export type OverlapReason = 'not-mine' | 'no-slot' | 'series' | 'moving';

/** The pair's key: each event by its calendar and its series (its id out of one), sorted, so (a, b) is (b, a). */
const keyOf = (a: Row, b: Row) =>
  PREFIX +
  [a, b]
    .map((e) => `${e.calendar_id}/${e.series_id ?? e.id}`)
    .sort()
    .join('|');

/** The Paris day and minute of the day of an instant. */
function paris(ms: number): { day: string; min: number } {
  const wall = ms + parisOffset(ms);
  return { day: new Date(wall).toISOString().slice(0, 10), min: Math.floor(wall / 60_000) % 1440 };
}

/** What a slot must not cross: busy events (not « disponible », not declined) and the slots pending cards offer. */
function busyAround(db: DatabaseSync, fromMs: number, moved: string): [number, number][] {
  const events = db
    .prepare(
      `SELECT start_ms, end_ms FROM calendar_events
       WHERE all_day = 0 AND free = 0 AND declined = 0 AND id <> ? AND start_ms < ? AND end_ms > ?`,
    )
    .all(moved, fromMs + DAY_MS, fromMs) as { start_ms: number; end_ms: number }[];
  const offered = (
    db
      .prepare(
        `SELECT input FROM pina_cards
         WHERE status = 'pending' AND action = 'event.update' AND call_id LIKE '${PREFIX}%'`,
      )
      .all() as { input: string }[]
  ).map((r) => JSON.parse(r.input) as { start: string; end: string });
  return [
    ...events.map((e): [number, number] => [e.start_ms, e.end_ms]),
    ...offered.map((o): [number, number] => [Date.parse(o.start), Date.parse(o.end)]),
  ];
}

/**
 * The first start, on the quarter of an hour, from `fromMs` on the Paris `day`, of a free slot of `duration`
 * between 8:00 and 22:00. Never in the past: `fromMs` is the end of a conflict that has not begun.
 */
function freeSlot(db: DatabaseSync, day: string, fromMs: number, duration: number, moved: string) {
  const busy = busyAround(db, fromMs, moved);
  for (let s = Math.ceil(fromMs / QUARTER_MS) * QUARTER_MS; ; s += QUARTER_MS) {
    const start = paris(s);
    const end = paris(s + duration);
    if (start.day !== day || end.day !== day || end.min > LAST_MIN) return undefined;
    if (start.min < FIRST_MIN) continue;
    if (!busy.some(([b0, b1]) => b0 < s + duration && b1 > s)) return s;
  }
}

interface Pending {
  id: number;
  call_id: string;
  action: string;
  input: string;
}

/** The pending cards of the detection. */
function pendingCards(db: DatabaseSync): Pending[] {
  return db
    .prepare(
      `SELECT id, call_id, action, input FROM pina_cards
       WHERE turn = 0 AND status = 'pending' AND call_id LIKE '${PREFIX}%'`,
    )
    .all() as unknown as Pending[];
}

/** A card that proposes a move, and the slot taken since by another busy event. */
function slotTaken(db: DatabaseSync, c: Pending): boolean {
  if (c.action !== 'event.update') return false;
  const o = JSON.parse(c.input) as { id: string; start: string; end: string };
  return !!db
    .prepare(
      `SELECT 1 FROM calendar_events
       WHERE all_day = 0 AND free = 0 AND declined = 0 AND id <> ? AND start_ms < ? AND end_ms > ?`,
    )
    .get(o.id, Date.parse(o.end), Date.parse(o.start));
}

/** The Paris day before a day `AAAA-MM-JJ`. */
const eveOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/**
 * One pass, at the end of each agenda sync: takes back the pending cards whose conflict is gone or whose
 * slot got busy (even in pause: it adds nothing), then, out of pause, makes a card for each new conflict of
 * the seven coming days, the closest first, three a day at most. A pair that had a card comes back once, on
 * the Paris eve of its next conflict, if that card expired unanswered; never after a decision.
 */
export function proposeOverlaps(db: DatabaseSync, now: Date): void {
  const nowMs = now.getTime();
  const main = mainCalendar(db);
  // Timed, busy, not declined, not begun, not empty: the events that can be in a real conflict.
  const rows = db
    .prepare(
      `SELECT calendar_id, id, title, start_ms, end_ms, solo, series_id FROM calendar_events
       WHERE all_day = 0 AND free = 0 AND declined = 0 AND end_ms > start_ms AND start_ms > ? AND start_ms < ?
       ORDER BY start_ms, calendar_id, id`,
    )
    .all(nowMs, nowMs + HORIZON_MS) as unknown as Row[];
  // The same event seen in two calendars is one event, the main calendar's copy if it has one.
  const byId = new Map<string, Row>();
  for (const r of rows) if (!byId.has(r.id) || r.calendar_id === main) byId.set(r.id, r);
  const events = [...byId.values()];

  const pairs: [Row, Row][] = [];
  for (let i = 0; i < events.length; i++)
    for (let j = i + 1; j < events.length && events[j]!.start_ms < events[i]!.end_ms; j++)
      pairs.push([events[i]!, events[j]!]);

  const live = new Set(pairs.map(([a, b]) => keyOf(a, b)));
  for (const c of pendingCards(db)) if (!live.has(c.call_id) || slotTaken(db, c)) withdrawCard(db, c.id);
  if (getState(db).paused) return;

  const today = dayOf(now);
  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM pina_cards WHERE turn = 0 AND day = ? AND call_id LIKE '${PREFIX}%'`,
  );
  const known = db.prepare('SELECT status FROM pina_cards WHERE call_id = ?');
  // The events a pending card already offers to move: never two cards for one event.
  const moving = new Set(
    pendingCards(db).flatMap((c) =>
      c.action === 'event.update' ? [(JSON.parse(c.input) as { id: string }).id] : [],
    ),
  );
  const seen = new Set<string>();
  for (const [a, b] of pairs) {
    if ((count.get(today) as { n: number }).n >= MAX_PER_DAY) return;
    const key = keyOf(a, b);
    // A series' pair is judged on its next occurrence only.
    if (seen.has(key)) continue;
    seen.add(key);
    const cards = known.all(key) as { status: string }[];
    const reminder =
      cards.length === 1 && cards[0]!.status === 'expired' && today === eveOf(paris(b.start_ms).day);
    if (cards.length && !reminder) continue;
    const moved = make(db, now, key, a, b, main, moving);
    if (moved) moving.add(moved);
    emitEvent(
      db,
      {
        type: 'agenda.overlap',
        importance: 'log',
        title: `« ${a.title} » et « ${b.title} » se chevauchent`,
        link: '#/agenda',
      },
      now,
    );
  }
}

/**
 * The card of one conflict (`a` starts first); the id of the event it offers to move, if any. Only an event
 * theirs alone in the main calendar moves: elsewhere, even organized by self, it may be another's or read-only.
 */
function make(
  db: DatabaseSync,
  now: Date,
  key: string,
  a: Row,
  b: Row,
  main: string | undefined,
  moving: Set<string>,
): string | undefined {
  const card = { day: dayOf(now), turn: 0, callId: key, now };
  const day = paris(b.start_ms).day;
  const after = Math.max(a.end_ms, b.end_ms);
  let reason: OverlapReason = 'not-mine';
  if (a.series_id && b.series_id) {
    // Moving one occurrence would leave the next weeks' conflict, with no card.
    reason = 'series';
  } else {
    // An event alone before an occurrence; between two alike, the later one, so the earlier keeps its start.
    const mine = [b, a]
      .filter((e) => e.solo === 1 && e.calendar_id === main)
      .sort((x, y) => Number(!!x.series_id) - Number(!!y.series_id));
    const movable = mine.filter((e) => !moving.has(e.id));
    if (mine.length && !movable.length) reason = 'moving';
    for (const e of movable) {
      reason = 'no-slot';
      const start = freeSlot(db, day, after, e.end_ms - e.start_ms, e.id);
      if (start === undefined) continue;
      const other = e === a ? b : a;
      addCard(db, {
        ...card,
        action: 'event.update',
        effect: 'write',
        input: {
          calendarId: e.calendar_id,
          id: e.id,
          start: new Date(start).toISOString(),
          end: new Date(start + e.end_ms - e.start_ms).toISOString(),
          conflit: { title: e.title, other: other.title },
        },
      });
      return e.id;
    }
  }
  addCard(db, {
    ...card,
    action: 'agenda.list',
    effect: 'read',
    input: {
      from: new Date(b.start_ms).toISOString(),
      to: new Date(Math.min(a.end_ms, b.end_ms)).toISOString(),
      conflit: { titles: [a.title, b.title], reason },
    },
  });
  return undefined;
}
