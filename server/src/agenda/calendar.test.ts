import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { openDb } from '../db.ts';
import { getSyncState, setSyncState } from '../gmail/store.ts';
import { SELF } from '../testing/fake-agenda.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';
import { listCalendars } from './calendar.ts';
import { agendaRange } from './unified.ts';

const meeting = (id: string, start: string, end: string, summary = `Réunion ${id}`) => ({
  id,
  summary,
  start: { dateTime: start },
  end: { dateTime: end },
});

const all = (db: Parameters<typeof agendaRange>[0]) => agendaRange(db, '2026-01-01', '2028-01-01');

describe('calendar sync', () => {
  it('fetches the selected calendars only, single events within −30 / +365 days', async () => {
    const h = await makeAgendaHarness();
    h.agenda.addCalendar('hidden', 'Anniversaires', { selected: false });
    h.agenda.putEvent('primary', meeting('e1', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'));
    h.agenda.putEvent('hidden', meeting('e2', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'));
    await h.syncAgenda();
    expect(all(h.db).map((i) => i.id)).toEqual(['e1']);
    const list = h.calls.find((c) => c.url.includes('/calendars/primary/events'))!;
    const q = new URL(list.url).searchParams;
    expect(q.get('singleEvents')).toBe('true');
    expect(q.get('timeMin')).toBe('2026-10-03T08:00:00.000Z');
    expect(q.get('timeMax')).toBe('2027-11-02T08:00:00.000Z');
  });

  it('lists the main calendar first, and read-only calendars as not writable', async () => {
    const h = await makeAgendaHarness();
    // Titled to sort before the main calendar, as Google's « Jours fériés… » before a lower-case address.
    h.agenda.addCalendar('holidays', 'Jours fériés', { accessRole: 'reader' });
    h.agenda.addCalendar('shared', 'Associatif', { accessRole: 'writer' });
    await h.syncAgenda();
    expect(listCalendars(h.db)).toEqual([
      { id: 'primary', title: 'Personnel', writable: true },
      { id: 'shared', title: 'Associatif', writable: true },
      { id: 'holidays', title: 'Jours fériés', writable: false },
    ]);
  });

  it('follows a move and a deletion made on Google', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', meeting('e1', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'));
    h.agenda.putEvent('primary', meeting('e2', '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z'));
    await h.syncAgenda();
    h.agenda.putEvent('primary', meeting('e1', '2026-11-05T14:00:00Z', '2026-11-05T15:00:00Z'));
    h.agenda.cancelEvent('primary', 'e2');
    await h.syncAgenda();
    const listed = all(h.db);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'e1', start: '2026-11-05T14:00:00.000Z' });
    const incremental = h.calls.filter((c) => c.url.includes('syncToken='));
    expect(incremental.length).toBeGreaterThan(0);
  });

  it('resyncs in full after a 410, without duplicates', async () => {
    const h = await makeAgendaHarness();
    for (const id of ['e1', 'e2', 'e3'])
      h.agenda.putEvent('primary', meeting(id, '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'));
    await h.syncAgenda();
    h.agenda.cancelEvent('primary', 'e3');
    h.agenda.expireSyncTokens();
    await h.syncAgenda();
    expect(all(h.db).map((i) => i.id)).toEqual(['e1', 'e2']);
  });

  it('emits agenda.changed when something changed, and only then', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', meeting('e1', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'));
    await h.syncAgenda();
    await h.syncAgenda();
    const changed = eventsSince(h.db).filter((e) => e.type === 'agenda.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.importance).toBe('log');
  });

  it('creates and moves an event from Acedia, the cache following at once', async () => {
    const h = await makeAgendaHarness();
    await h.syncAgenda();
    const created = await h.call('POST', '/api/events/primary', {
      title: 'Dentiste',
      start: '2026-11-06T15:00:00.000Z',
      end: '2026-11-06T15:30:00.000Z',
      allDay: false,
      reminders: [10],
    });
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect(h.agenda.event('primary', id)?.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }],
    });
    const moved = await h.call('PATCH', `/api/events/primary/${id}`, {
      start: '2026-11-07T15:00:00.000Z',
      end: '2026-11-07T15:30:00.000Z',
    });
    expect(moved.body).toMatchObject({
      id,
      title: 'Dentiste',
      start: '2026-11-07T15:00:00.000Z',
      reminders: [10],
    });
    expect(all(h.db)[0]).toMatchObject({ id, start: '2026-11-07T15:00:00.000Z' });
    expect((await h.call('DELETE', `/api/events/primary/${id}`)).status).toBe(200);
    expect(all(h.db)).toEqual([]);
    expect((await h.call('PATCH', '/api/events/primary/nope', { title: 'x' })).status).toBe(404);
  });
});

describe('what the sync keeps for the overlaps', () => {
  const when = { start: { dateTime: '2026-11-03T09:00:00Z' }, end: { dateTime: '2026-11-03T10:00:00Z' } };
  const flags = (db: Parameters<typeof agendaRange>[0], id: string) =>
    db.prepare('SELECT free, declined, solo, series_id FROM calendar_events WHERE id = ?').get(id);

  it('reads whether it is « disponible », declined, theirs alone, and its series', async () => {
    const h = await makeAgendaHarness();
    const put = (id: string, extra: object) => h.agenda.putEvent('primary', { id, ...when, ...extra });
    put('plain', {});
    put('free', { transparency: 'transparent' });
    put('busy', { transparency: 'opaque' });
    put('mine', { organizer: SELF });
    put('mine-self-guest', { organizer: SELF, attendees: [{ ...SELF, responseStatus: 'accepted' }] });
    put('guests', {
      organizer: SELF,
      attendees: [{ ...SELF, responseStatus: 'accepted' }, { email: 'invite@example.org' }],
    });
    put('theirs', {
      organizer: { email: 'orga@example.org' },
      attendees: [{ ...SELF, responseStatus: 'accepted' }, { email: 'orga@example.org' }],
    });
    put('declined', {
      organizer: { email: 'orga@example.org' },
      attendees: [{ ...SELF, responseStatus: 'declined' }],
    });
    put('occurrence', { organizer: SELF, recurringEventId: 'serie-1' });
    await h.syncAgenda();
    const row = (id: string) => flags(h.db, id);
    expect(row('plain')).toMatchObject({ free: 0, declined: 0, solo: 0, series_id: null });
    expect(row('free')).toMatchObject({ free: 1 });
    expect(row('busy')).toMatchObject({ free: 0 });
    expect(row('mine')).toMatchObject({ solo: 1 });
    expect(row('mine-self-guest')).toMatchObject({ solo: 1 });
    expect(row('guests')).toMatchObject({ solo: 0, declined: 0 });
    expect(row('theirs')).toMatchObject({ solo: 0, declined: 0 });
    expect(row('declined')).toMatchObject({ declined: 1, solo: 0 });
    expect(row('occurrence')).toMatchObject({ solo: 1, series_id: 'serie-1' });
  });

  it('counts a change of guests as a change of the cache', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', { id: 'e1', ...when, organizer: SELF });
    await h.syncAgenda();
    h.agenda.putEvent('primary', {
      id: 'e1',
      ...when,
      organizer: SELF,
      attendees: [{ ...SELF }, { email: 'invite@example.org' }],
    });
    await h.syncAgenda();
    expect(flags(h.db, 'e1')).toMatchObject({ solo: 0 });
    expect(eventsSince(h.db).filter((e) => e.type === 'agenda.changed')).toHaveLength(2);
  });

  it('after the migration, a base that already had tokens reads the whole window again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acedia-migration-'));
    const path = join(dir, 'acedia.db');
    const opened: { close(): void }[] = [];
    try {
      const legacy = [
        'calendar_id',
        'id',
        'title',
        'start',
        'end',
        'start_ms',
        'end_ms',
        'all_day',
        'location',
        'reminders',
      ];
      const columns = (db: ReturnType<typeof openDb>) =>
        (db.prepare('PRAGMA table_info(calendar_events)').all() as { name: string }[]).map((c) => c.name);

      // A fresh base has the four new columns...
      const db = openDb(path);
      opened.push(db);
      const added = columns(db).filter((c) => !legacy.includes(c));
      expect(added).toHaveLength(4);
      // ...so go back to the base as it was before their migration (the 19th): without them, with its tokens,
      // and without what the migrations after it added.
      for (const c of added) db.exec(`ALTER TABLE calendar_events DROP COLUMN ${c}`);
      setSyncState(db, 'cal:primary', 'v1');
      setSyncState(db, 'cal:shared', 'v2');
      setSyncState(db, 'gmail:history', '42');
      db.exec('ALTER TABLE proposals DROP COLUMN synthesis');
      db.exec('UPDATE schema_version SET version = 18');
      db.close();

      const migrated = openDb(path);
      opened.push(migrated);
      expect(columns(migrated).filter((c) => !legacy.includes(c))).toHaveLength(4);
      expect(getSyncState(migrated, 'cal:primary')).toBeUndefined();
      expect(getSyncState(migrated, 'cal:shared')).toBeUndefined();
      expect(getSyncState(migrated, 'gmail:history')).toBe('42');
      migrated.close();
    } finally {
      for (const db of opened) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
