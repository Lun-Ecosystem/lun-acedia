import { describe, expect, it } from 'vitest';
import type { AgendaEvent } from '../types.ts';
import { allDayBars, layoutDay, remindersText, visibleDays } from './dates.ts';

const ev = (id: string, start: string, end: string, allDay = false): AgendaEvent => ({
  kind: 'event',
  id,
  calendarId: 'c',
  title: id,
  start,
  end,
  allDay,
  reminders: [],
});
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

describe('layoutDay', () => {
  it('puts overlapping events side by side, and a later one back to full width', () => {
    const placed = layoutDay(
      [
        ev('pr', at(21, 15), at(21, 16)),
        ev('sport', at(21, 15, 30), at(21, 16, 30)),
        ev('cine', at(21, 18), at(21, 19)),
      ],
      new Date(2026, 9, 21),
    );
    const by = Object.fromEntries(placed.map((p) => [p.event.id, p]));
    expect(by.pr).toMatchObject({ top: 900, bottom: 960, lane: 0, lanes: 2 });
    expect(by.sport).toMatchObject({ top: 930, bottom: 990, lane: 1, lanes: 2 });
    expect(by.cine).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('clips an event over midnight to each day, a DST day included', () => {
    // 25 October 2026: the clocks go back in Paris; the day still draws as 24 hours.
    const night = ev('night', at(24, 22), at(25, 4));
    expect(layoutDay([night], new Date(2026, 9, 24))[0]).toMatchObject({ top: 1320, bottom: 1440 });
    expect(layoutDay([night], new Date(2026, 9, 25))[0]).toMatchObject({ top: 0, bottom: 240 });
    expect(layoutDay([night], new Date(2026, 9, 26))).toEqual([]);
  });
});

describe('allDayBars', () => {
  it('spans the days covered and stacks the bars that meet', () => {
    const week = visibleDays('week', new Date(2026, 9, 21));
    const bars = allDayBars(
      [
        ev('nantes', '2026-10-24', '2026-10-26', true),
        ev('lea', '2026-10-22', '2026-10-23', true),
        ev('long', '2026-10-17', '2026-10-25', true),
      ],
      week,
    );
    const by = Object.fromEntries(bars.map((b) => [b.event.id, b]));
    expect(by.long).toMatchObject({ col: 0, span: 6, row: 0 });
    expect(by.lea).toMatchObject({ col: 3, span: 1, row: 1 });
    expect(by.nantes).toMatchObject({ col: 5, span: 2, row: 1 });
  });
});

describe('remindersText', () => {
  it('says the reminders in French', () => {
    expect(remindersText([30])).toBe('Rappel 30 min avant');
    expect(remindersText([60, 10, 1440])).toBe('Rappels 10 min, 1 h et 1 jour avant');
  });
});
