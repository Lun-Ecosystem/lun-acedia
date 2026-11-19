import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { setPaused } from '../contract/state.ts';
import { expireCards } from '../pina/agent.ts';
import { dayOf, getCard, purge, putPinaSettings, setCardStatus, type Card } from '../pina/store.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';
import { guestEvent, soloEvent, type FakeEvent } from '../testing/fake-agenda.ts';

/*
 * What counts as a conflict, which event moves, to when, and how often a card comes back. The harness clock is
 * Monday 2026-11-02 09:00 in Paris (08:00 UTC); Paris is UTC+1 all November, so `paris(d, h)` is `h - 1` UTC.
 */
const paris = (day: number, h: number, min = 0) =>
  new Date(Date.UTC(2026, 10, day, h - 1, min)).toISOString();
const HOUR = 3_600_000;

type Harness = Awaited<ReturnType<typeof makeAgendaHarness>>;

/** The cards the detection made, in order. They share the `chevauchement:` call id and the turn 0. */
function overlapCards(db: DatabaseSync): Card[] {
  const ids = db
    .prepare("SELECT id FROM pina_cards WHERE call_id LIKE 'chevauchement:%' ORDER BY id")
    .all() as { id: number }[];
  return ids.map((r) => getCard(db, r.id)!);
}
const overlapEvents = (db: DatabaseSync) => eventsSince(db).filter((e) => e.type === 'agenda.overlap');
const writes = (h: Harness) => h.calls.filter((c) => c.method !== 'GET').length;

async function run(events: FakeEvent[], calendar = 'primary') {
  const h = await makeAgendaHarness();
  for (const e of events) h.agenda.putEvent(calendar, e);
  await h.syncAgenda();
  return h;
}

/** Tomorrow (Nov 3): `a` 10:00-11:00 and `b` 10:30-11:30 Paris overlap for 30 minutes. */
const A = (extra: Partial<FakeEvent> = {}) =>
  soloEvent('a', paris(3, 10), paris(3, 11), { summary: 'Dentiste', ...extra });
const B = (extra: Partial<FakeEvent> = {}) =>
  guestEvent('b', paris(3, 10, 30), paris(3, 11, 30), { summary: 'Réunion client', ...extra });

describe('what counts as a conflict', () => {
  it('two timed events that strictly overlap make one pending card', async () => {
    const h = await run([A(), B()]);
    const cards = overlapCards(h.db);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: 'pending', turn: 0, day: dayOf(h.clock()) });
    expect(cards[0]!.callId).toMatch(/^chevauchement:/);
  });

  const none: [string, () => FakeEvent[]][] = [
    ['two ranges that only touch', () => [A(), soloEvent('b', paris(3, 11), paris(3, 12))]],
    [
      'an all-day event',
      () => [
        A(),
        soloEvent('b', '2026-11-03', '2026-11-03', {
          start: { date: '2026-11-03' },
          end: { date: '2026-11-04' },
        }),
      ],
    ],
    [
      'two all-day events',
      () => [
        soloEvent('a', '', '', { start: { date: '2026-11-03' }, end: { date: '2026-11-04' } }),
        soloEvent('b', '', '', { start: { date: '2026-11-03' }, end: { date: '2026-11-04' } }),
      ],
    ],
    [
      'an event CrOliX declined',
      () => [A(), B({ attendees: [{ ...B().attendees![0]!, responseStatus: 'declined' }] })],
    ],
    ['an event marked « disponible »', () => [A(), B({ transparency: 'transparent' })]],
    ['the other one marked « disponible »', () => [A({ transparency: 'transparent' }), B()]],
    [
      'an event already past',
      () => [soloEvent('a', paris(1, 10), paris(1, 11)), guestEvent('b', paris(1, 10, 30), paris(1, 11, 30))],
    ],
    // Now is Nov 2, 09:00 Paris: `a` began at 08:00.
    [
      'an event already begun',
      () => [soloEvent('a', paris(2, 8), paris(2, 10)), guestEvent('b', paris(2, 9, 30), paris(2, 10, 30))],
    ],
    [
      'a conflict beyond the seven coming days',
      () => [
        soloEvent('a', paris(12, 10), paris(12, 11)),
        guestEvent('b', paris(12, 10, 30), paris(12, 11, 30)),
      ],
    ],
  ];
  it.each(none)('no card for %s', async (_name, events) => {
    const h = await run(events());
    expect(overlapCards(h.db)).toEqual([]);
    expect(overlapEvents(h.db)).toEqual([]);
  });

  it('a conflict six days away is inside the horizon', async () => {
    const h = await run([
      soloEvent('a', paris(8, 10), paris(8, 11)),
      guestEvent('b', paris(8, 10, 30), paris(8, 11, 30)),
    ]);
    expect(overlapCards(h.db)).toHaveLength(1);
  });

  it('the same event seen in two calendars does not overlap itself', async () => {
    const h = await makeAgendaHarness();
    h.agenda.addCalendar('shared', 'Partagé');
    h.agenda.putEvent('primary', A());
    h.agenda.putEvent('shared', A());
    await h.syncAgenda();
    expect(overlapCards(h.db)).toEqual([]);
  });

  it('the same event seen in two calendars counts once against a third', async () => {
    const h = await makeAgendaHarness();
    h.agenda.addCalendar('shared', 'Partagé');
    h.agenda.putEvent('primary', A());
    h.agenda.putEvent('shared', A());
    h.agenda.putEvent('primary', B());
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
  });

  it('a conflict across two calendars is a conflict', async () => {
    const h = await makeAgendaHarness();
    h.agenda.addCalendar('shared', 'Partagé');
    h.agenda.putEvent('primary', A());
    h.agenda.putEvent('shared', B());
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
  });
});

describe('which event the card offers to move', () => {
  it('proposes the one CrOliX alone has, without its title', async () => {
    const h = await run([A(), B()]);
    const [card] = overlapCards(h.db);
    // The first free hour after the conflict: 11:30 to 12:30 Paris.
    expect(card).toMatchObject({
      action: 'event.update',
      effect: 'write',
      input: {
        calendarId: 'primary',
        id: 'a',
        start: paris(3, 11, 30),
        end: paris(3, 12, 30),
        conflit: { title: 'Dentiste', other: 'Réunion client' },
      },
    });
    expect(Object.keys(card!.input as object).sort()).toEqual([
      'calendarId',
      'conflit',
      'end',
      'id',
      'start',
    ]);
  });

  it('proposes the solo one whichever comes first', async () => {
    const h = await run([
      guestEvent('a', paris(3, 10), paris(3, 11), { summary: 'Réunion client' }),
      soloEvent('b', paris(3, 10, 30), paris(3, 11, 30), { summary: 'Dentiste' }),
    ]);
    const [card] = overlapCards(h.db);
    expect(card).toMatchObject({
      action: 'event.update',
      input: { id: 'b', start: paris(3, 11, 30), end: paris(3, 12, 30) },
    });
  });

  it('with two events of their own, it proposes one of them', async () => {
    const h = await run([A(), soloEvent('b', paris(3, 10, 30), paris(3, 11, 30))]);
    const [card] = overlapCards(h.db);
    expect(card).toMatchObject({ action: 'event.update' });
    expect(['a', 'b']).toContain((card!.input as { id: string }).id);
  });

  it('with two events of their own, the later one moves; the earlier one when the later has no slot', async () => {
    const later = await run([A(), soloEvent('b', paris(3, 10, 30), paris(3, 11, 30))]);
    expect(overlapCards(later.db)[0]).toMatchObject({ input: { id: 'b', start: paris(3, 11, 30) } });
    // Busy until 21:00: `b` (1 h 30) would end after 22:00, `a` (1 h) fits from 21:00.
    const h = await run([
      soloEvent('a', paris(3, 10), paris(3, 11)),
      soloEvent('b', paris(3, 10, 30), paris(3, 12)),
      soloEvent('c', paris(3, 12), paris(3, 21)),
    ]);
    expect(overlapCards(h.db)[0]).toMatchObject({ input: { id: 'a', start: paris(3, 21) } });
  });

  it('the key of a pair is sorted: the same whichever event starts first', async () => {
    const first = await run([A(), B()]);
    const swapped = await run([
      soloEvent('a', paris(3, 10, 30), paris(3, 11, 30)),
      guestEvent('b', paris(3, 10), paris(3, 11)),
    ]);
    expect(overlapCards(first.db)[0]!.callId).toBe('chevauchement:primary/a|primary/b');
    expect(overlapCards(swapped.db)[0]!.callId).toBe('chevauchement:primary/a|primary/b');
  });

  const signals: [string, () => FakeEvent[]][] = [
    [
      'a guest more on one, the other not theirs either',
      () => [B(), guestEvent('a', paris(3, 10), paris(3, 11))],
    ],
    [
      'another organizer',
      () => [
        A({ organizer: { email: 'orga@example.org' } }),
        B({ organizer: { email: 'autre@example.org' } }),
      ],
    ],
    [
      'no known organizer',
      () => [A({ organizer: undefined as never }), B({ organizer: undefined as never })],
    ],
    [
      'a guest of the owner on a solo-looking event',
      () => [A({ attendees: [{ email: 'invite@example.org' }] }), B()],
    ],
  ];
  it.each(signals)('signals without proposing when neither is theirs alone: %s', async (_name, events) => {
    const h = await run(events());
    const cards = overlapCards(h.db);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      action: 'agenda.list',
      effect: 'read',
      status: 'pending',
      input: { conflit: { reason: 'not-mine' } },
    });
    const input = cards[0]!.input as { from: string; to: string };
    // The range of the conflict: at least from 10:30 to 11:00 Paris.
    expect(Date.parse(input.from)).toBeLessThanOrEqual(Date.parse(paris(3, 10, 30)));
    expect(Date.parse(input.to)).toBeGreaterThanOrEqual(Date.parse(paris(3, 11)));
  });

  it('names both events on the signalling card, the earlier first', async () => {
    const h = await run([
      guestEvent('a', paris(3, 10), paris(3, 11), { summary: 'Dentiste' }),
      B({ summary: 'Réunion client' }),
    ]);
    expect(overlapCards(h.db)[0]!.input).toMatchObject({
      conflit: { titles: ['Dentiste', 'Réunion client'], reason: 'not-mine' },
    });
  });

  it('an event alone against a series: the event alone is proposed when it is theirs alone', async () => {
    const h = await run([A(), B({ recurringEventId: 'serie-b', id: 'b_20261103' })]);
    const [card] = overlapCards(h.db);
    expect(card).toMatchObject({ action: 'event.update', input: { id: 'a' } });
  });

  it('a series occurrence against an event that is not theirs alone: the occurrence is proposed', async () => {
    const h = await run([
      soloEvent('s_20261103', paris(3, 10), paris(3, 11), { recurringEventId: 's', summary: 'Sport' }),
      B(),
    ]);
    const [card] = overlapCards(h.db);
    expect(card).toMatchObject({ action: 'event.update', input: { id: 's_20261103' } });
  });

  it('two overlapping series: a card that signals, whoever organizes them', async () => {
    const h = await run([
      soloEvent('s_20261103', paris(3, 10), paris(3, 11), { recurringEventId: 's' }),
      soloEvent('t_20261103', paris(3, 10, 30), paris(3, 11, 30), { recurringEventId: 't' }),
    ]);
    const cards = overlapCards(h.db);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ action: 'agenda.list', effect: 'read' });
  });
});

describe('the free slot', () => {
  it('is the first free one of the same duration after the conflict, not before it', async () => {
    // Free from 8:00: a slot before the conflict would be a move to the morning.
    const h = await run([A(), B()]);
    const input = overlapCards(h.db)[0]!.input as { start: string; end: string };
    expect(Date.parse(input.end) - Date.parse(input.start)).toBe(HOUR);
    expect(input.start).toBe(paris(3, 11, 30));
  });

  it('keeps the duration, and skips a busy event to the next quarter of an hour', async () => {
    const h = await run([
      soloEvent('a', paris(3, 10), paris(3, 11, 30), { summary: 'Dentiste' }),
      B({ start: { dateTime: paris(3, 11) }, end: { dateTime: paris(3, 11, 30) } }),
      soloEvent('c', paris(3, 11, 30), paris(3, 12, 10)),
    ]);
    const [card] = overlapCards(h.db);
    // 1 h 30 long, then free from 12:10: the next quarter is 12:15.
    expect(card).toMatchObject({
      action: 'event.update',
      input: { id: 'a', start: paris(3, 12, 15), end: paris(3, 13, 45) },
    });
  });

  it('a slot may end at 22:00 exactly', async () => {
    const h = await run([
      soloEvent('a', paris(3, 20), paris(3, 21)),
      guestEvent('b', paris(3, 20, 30), paris(3, 21)),
    ]);
    expect(overlapCards(h.db)[0]).toMatchObject({
      action: 'event.update',
      input: { id: 'a', start: paris(3, 21), end: paris(3, 22) },
    });
  });

  it('is not offered past 22:00: the card signals', async () => {
    const h = await run([
      soloEvent('a', paris(3, 20, 30), paris(3, 21, 30)),
      guestEvent('b', paris(3, 21), paris(3, 22)),
    ]);
    expect(overlapCards(h.db)).toMatchObject([
      { action: 'agenda.list', input: { conflit: { reason: 'no-slot' } } },
    ]);
  });

  // The server may run in UTC: the day runs from 8:00 to 22:00 in Paris all the same.
  it.each(['UTC', 'Pacific/Auckland'])('is 8:00 to 22:00 in Paris on a server in %s', async (zone) => {
    const before = process.env.TZ;
    process.env.TZ = zone;
    try {
      // A slot of 21:30 to 22:30 Paris would be inside a 22:00 limit read in the server's own time.
      const h = await run([
        soloEvent('a', paris(3, 20), paris(3, 21)),
        guestEvent('b', paris(3, 20, 30), paris(3, 21, 30)),
      ]);
      expect(overlapCards(h.db)).toMatchObject([
        { action: 'agenda.list', input: { conflit: { reason: 'no-slot' } } },
      ]);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('is not blocked by an event « disponible » or one CrOliX declined', async () => {
    const h = await run([
      A(),
      B(),
      soloEvent('c', paris(3, 11, 30), paris(3, 12, 30), { transparency: 'transparent' }),
      guestEvent('d', paris(3, 11, 30), paris(3, 12, 30), {
        attendees: [{ ...B().attendees![0]!, responseStatus: 'declined' }],
      }),
    ]);
    expect(overlapCards(h.db)[0]).toMatchObject({ input: { id: 'a', start: paris(3, 11, 30) } });
  });

  it('counts a slot already offered by a pending card as busy', async () => {
    // b (guest) is crossed by a1 (09:00-10:00) and a2 (10:00-11:00), both theirs alone.
    const h = await run([
      soloEvent('a1', paris(3, 9), paris(3, 10)),
      guestEvent('b', paris(3, 9, 30), paris(3, 10, 30)),
      soloEvent('a2', paris(3, 10), paris(3, 11)),
    ]);
    const cards = overlapCards(h.db);
    expect(cards).toHaveLength(2);
    const slots = cards.map((c) => c.input as { id: string; start: string });
    expect(slots.find((s) => s.id === 'a1')!.start).toBe(paris(3, 11));
    expect(slots.find((s) => s.id === 'a2')!.start).toBe(paris(3, 12));
  });
});

describe('against weariness', () => {
  it('two passes in a row make one card, and one event for the contract', async () => {
    const h = await run([A(), B()]);
    await h.syncAgenda();
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
    expect(overlapEvents(h.db)).toHaveLength(1);
  });

  it('a card key is `chevauchement:` and names both events', async () => {
    const h = await run([A(), B()]);
    const key = overlapCards(h.db)[0]!.callId;
    expect(key).toContain('a');
    expect(key).toContain('b');
  });

  it.each(['done', 'refused', 'failed'] as const)('a %s card brings its pair back never', async (status) => {
    const h = await run([A(), B()]);
    const [card] = overlapCards(h.db);
    expect(setCardStatus(h.db, card!.id, 'pending', status, { at: h.clock() })).toBe(true);
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
    expect(overlapEvents(h.db)).toHaveLength(1);
  });

  it('an expired card brings its pair back never, the day after, nor 30 days after', async () => {
    const h = await run([A(), B()]);
    h.advance(24 * HOUR);
    expireCards(h.db, dayOf(h.clock()));
    expect(overlapCards(h.db)[0]!.status).toBe('expired');
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
    // The purge of the cards of 30 days ago keeps the ones of the detection.
    purge(h.db, '2027-01-15');
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
    expect(overlapEvents(h.db)).toHaveLength(1);
  });

  it('two series that overlap every week make one card in all', async () => {
    const occurrences = (days: number[]) =>
      days.flatMap((d) => [
        soloEvent(`s_${d}`, paris(d, 10), paris(d, 11), { recurringEventId: 's' }),
        soloEvent(`t_${d}`, paris(d, 10, 30), paris(d, 11, 30), { recurringEventId: 't' }),
      ]);
    const h = await run(occurrences([3, 5]));
    expect(overlapCards(h.db)).toHaveLength(1);
    // Six days later the next occurrences enter the horizon: the series is the key, not the occurrence.
    for (const e of occurrences([10, 12])) h.agenda.putEvent('primary', e);
    h.advance(6 * 24 * HOUR);
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
    expect(overlapEvents(h.db)).toHaveLength(1);
  });

  it('three cards of conflict a day at most, the closest first; the others the day after', async () => {
    const pairs = [3, 4, 5, 6, 7].flatMap((d) => [
      soloEvent(`a${d}`, paris(d, 15), paris(d, 16)),
      guestEvent(`b${d}`, paris(d, 15, 30), paris(d, 16, 30)),
    ]);
    const h = await run(pairs);
    const first = overlapCards(h.db);
    expect(first.map((c) => (c.input as { id: string }).id)).toEqual(['a3', 'a4', 'a5']);
    expect(overlapEvents(h.db)).toHaveLength(3);

    h.advance(24 * HOUR);
    await h.syncAgenda();
    const all = overlapCards(h.db);
    expect(all.map((c) => (c.input as { id: string }).id)).toEqual(['a3', 'a4', 'a5', 'a6', 'a7']);
    expect(all.map((c) => c.day)).toEqual([
      '2026-11-02',
      '2026-11-02',
      '2026-11-02',
      '2026-11-03',
      '2026-11-03',
    ]);
    expect(overlapEvents(h.db)).toHaveLength(5);
  });

  it('a pending card whose conflict was settled by hand goes at the next pass', async () => {
    const h = await run([A(), B()]);
    const [card] = overlapCards(h.db);
    h.agenda.putEvent('primary', B({ start: { dateTime: paris(3, 14) }, end: { dateTime: paris(3, 15) } }));
    await h.syncAgenda();
    expect(getCard(h.db, card!.id)).toBeUndefined();
    expect(overlapCards(h.db)).toEqual([]);
  });

  it('leaves alone a card already decided when its conflict is settled', async () => {
    const h = await run([A(), B()]);
    const [card] = overlapCards(h.db);
    setCardStatus(h.db, card!.id, 'pending', 'refused', { at: h.clock() });
    h.agenda.cancelEvent('primary', 'b');
    await h.syncAgenda();
    expect(getCard(h.db, card!.id)).toMatchObject({ status: 'refused' });
  });

  it('does not touch a card being run when its conflict is settled', async () => {
    const h = await run([A(), B()]);
    const [card] = overlapCards(h.db);
    const { runCard } = await import('../pina/agent.ts');
    const deps = { db: h.db, actions: h.actions, clock: h.clock };
    // `runCard` marks the card as running before its first await; the cache says the conflict is gone.
    h.db.prepare("DELETE FROM calendar_events WHERE id = 'b'").run();
    const running = runCard(deps, card!.id);
    // Imported here so that the other cases fail on their own, not on a missing module.
    const { proposeOverlaps } = await import('./overlaps.ts');
    await proposeOverlaps(h.db, h.clock());
    expect(getCard(h.db, card!.id)).toBeDefined();
    await running;
  });
});

describe('pause and mode', () => {
  it('in pause, no card is made, nor event; at the lifting, the detection resumes', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', A());
    h.agenda.putEvent('primary', B());
    setPaused(h.db, true);
    await h.syncAgenda();
    expect(overlapCards(h.db)).toEqual([]);
    expect(overlapEvents(h.db)).toEqual([]);
    setPaused(h.db, false);
    await h.syncAgenda();
    expect(overlapCards(h.db)).toHaveLength(1);
    expect(overlapEvents(h.db)).toHaveLength(1);
  });

  it('paused by the core stops it too', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', A());
    h.agenda.putEvent('primary', B());
    setPaused(h.db, true, 'core');
    await h.syncAgenda();
    expect(overlapCards(h.db)).toEqual([]);
  });

  it('in pause, a settled conflict still takes its pending card away', async () => {
    const h = await run([A(), B()]);
    const [card] = overlapCards(h.db);
    setPaused(h.db, true);
    h.agenda.cancelEvent('primary', 'b');
    await h.syncAgenda();
    expect(getCard(h.db, card!.id)).toBeUndefined();
  });

  it('« Faire tout de suite »: the card stays pending and Google is not called', async () => {
    const h = await makeAgendaHarness();
    putPinaSettings(h.db, { mode: 'immediate' });
    h.agenda.putEvent('primary', A());
    h.agenda.putEvent('primary', B());
    await h.syncAgenda();
    expect(overlapCards(h.db)).toMatchObject([{ status: 'pending' }]);
    expect(writes(h)).toBe(0);
    expect(h.agenda.event('primary', 'a')!.start.dateTime).toBe(paris(3, 10));
  });
});

describe('the event sent to the contract', () => {
  it('is `agenda.overlap`, `log`, once per card, with a link to the agenda', async () => {
    const h = await run([A(), B()]);
    await h.syncAgenda();
    const [event, ...others] = overlapEvents(h.db);
    expect(others).toEqual([]);
    expect(event).toMatchObject({ type: 'agenda.overlap', importance: 'log', link: '#/agenda' });
    expect(event!.title).toContain('Dentiste');
    expect(event!.title).toContain('Réunion client');
    expect(event!.title).toContain('se chevauchent');
  });

  it('a card that signals sends one too', async () => {
    const h = await run([B(), guestEvent('a', paris(3, 10), paris(3, 11))]);
    expect(overlapCards(h.db)).toHaveLength(1);
    expect(overlapEvents(h.db)).toMatchObject([{ importance: 'log' }]);
  });
});
