import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { local, makeAgendaHarness } from '../testing/agenda-harness.ts';
import { dueReminders, runReminders } from './reminders.ts';

const reminderEvents = (db: Parameters<typeof eventsSince>[0]) =>
  eventsSince(db).filter((e) => e.type === 'agenda.reminder');

describe('reminders', () => {
  it('emits a 10-minute reminder once, however many times the loop runs', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', {
      id: 'e1',
      summary: 'Oral',
      start: { dateTime: '2026-11-02T08:15:00.000Z' },
      end: { dateTime: '2026-11-02T09:00:00.000Z' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 10 },
          { method: 'email', minutes: 60 },
        ],
      },
    });
    await h.syncAgenda();
    expect(dueReminders(h.db, new Date('2026-11-02T08:04:00.000Z'))).toEqual([]);
    for (const at of ['08:05', '08:06', '08:07']) runReminders(h.db, new Date(`2026-11-02T${at}:00.000Z`));
    const sent = reminderEvents(h.db);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ importance: 'urgent', title: 'Oral dans 10 min' });
  });

  it('reminds of a task due today at 09:00 local time', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putTask('list1', {
      id: 't1',
      title: 'Payer le loyer',
      status: 'needsAction',
      due: '2026-11-02T00:00:00.000Z',
    });
    await h.syncAgenda();
    const [y, m, d] = [2026, 11, 2];
    expect(dueReminders(h.db, new Date(local(y, m, d, 8, 59)))).toEqual([]);
    runReminders(h.db, new Date(local(y, m, d, 9, 0)));
    runReminders(h.db, new Date(local(y, m, d, 9, 1)));
    const sent = reminderEvents(h.db);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Payer le loyer : à faire aujourd’hui');
  });

  it('uses the calendar default reminders for an all-day event without overrides', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', {
      id: 'bday',
      summary: 'Anniversaire de Léa',
      start: { date: '2026-11-05' },
      end: { date: '2026-11-06' },
      reminders: { useDefault: true },
    });
    await h.syncAgenda();
    // Default: 30 minutes before the start of the day.
    const due = dueReminders(h.db, new Date(local(2026, 11, 4, 23, 30)));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ itemId: 'bday', minutes: 30 });
  });

  it('does not fire reminders long past (the server was off)', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putEvent('primary', {
      id: 'e1',
      summary: 'Oral',
      start: { dateTime: '2026-11-02T08:15:00.000Z' },
      end: { dateTime: '2026-11-02T09:00:00.000Z' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    });
    await h.syncAgenda();
    expect(dueReminders(h.db, new Date('2026-11-02T08:30:00.000Z'))).toEqual([]);
  });
});
