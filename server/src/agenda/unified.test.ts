import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { local, makeAgendaHarness } from '../testing/agenda-harness.ts';
import { agendaRange, undatedTasks } from './unified.ts';

const forbidden = { status: 403, json: { error: { message: 'Forbidden' } } };

/** The harness with Google answering 403 to the reads of the calendars or lists whose URL contains `broken`. */
async function brokenHarness(...broken: string[]) {
  const h = await makeAgendaHarness();
  const real = h.agenda.handler;
  h.agenda.handler = (call) =>
    call.method === 'GET' && broken.some((b) => call.url.includes(b)) ? forbidden : real(call);
  return h;
}

describe('agendaRange', () => {
  it('returns the events overlapping the week and the tasks due in it, sorted', async () => {
    const h = await makeAgendaHarness();
    // Week of Monday 2 November 2026; a trip from Sunday 1 to Tuesday 3.
    h.agenda.putEvent('primary', {
      id: 'trip',
      summary: 'Voyage',
      start: { date: '2026-11-01' },
      end: { date: '2026-11-04' },
    });
    h.agenda.putEvent('primary', {
      id: 'class',
      summary: 'Cours',
      start: { dateTime: local(2026, 11, 3, 14) },
      end: { dateTime: local(2026, 11, 3, 16) },
      location: 'Salle B',
    });
    h.agenda.putEvent('primary', {
      id: 'later',
      summary: 'Plus tard',
      start: { dateTime: local(2026, 11, 10, 9) },
      end: { dateTime: local(2026, 11, 10, 10) },
    });
    h.agenda.putTask('list1', {
      id: 'wed',
      title: 'Rendre le TP',
      status: 'needsAction',
      due: '2026-11-04T00:00:00.000Z',
    });
    h.agenda.putTask('list1', {
      id: 'next',
      title: 'Hors semaine',
      status: 'needsAction',
      due: '2026-11-12T00:00:00.000Z',
    });
    await h.syncAgenda();

    const week = agendaRange(h.db, '2026-11-02', '2026-11-09');
    expect(week.map((i) => i.id)).toEqual(['trip', 'class', 'wed']);
    expect(week[0]).toEqual({
      kind: 'event',
      id: 'trip',
      calendarId: 'primary',
      title: 'Voyage',
      start: '2026-11-01',
      end: '2026-11-04',
      allDay: true,
      reminders: [30],
    });
    expect(week[1]).toMatchObject({ location: 'Salle B', allDay: false });
    expect(week[2]).toEqual({
      kind: 'task',
      id: 'wed',
      listId: 'list1',
      title: 'Rendre le TP',
      due: '2026-11-04',
      done: false,
    });

    const res = await h.call('GET', '/api/agenda?from=2026-11-02&to=2026-11-09');
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(['trip', 'class', 'wed']);
    expect((await h.call('GET', '/api/agenda?from=demain')).status).toBe(400);
  });

  it('lists the calendars and task lists for the forms', async () => {
    const h = await makeAgendaHarness();
    await h.syncAgenda();
    expect((await h.call('GET', '/api/calendars')).body.items).toEqual([
      { id: 'primary', title: 'Personnel', writable: true },
    ]);
    expect((await h.call('GET', '/api/task-lists')).body.items).toEqual([
      { id: 'list1', title: 'Mes tâches' },
    ]);
  });
});

describe('syncAgenda', () => {
  it('a calendar in error stops neither the next ones nor the tasks, then the error goes up with its name', async () => {
    const h = await brokenHarness('/calendars/primary/events');
    h.agenda.addCalendar('travail', 'Travail');
    h.agenda.putEvent('travail', {
      id: 'reunion',
      summary: 'Réunion',
      start: { dateTime: local(2026, 11, 3, 10) },
      end: { dateTime: local(2026, 11, 3, 11) },
    });
    h.agenda.putTask('list1', { id: 't1', title: 'Rendre le rapport', status: 'needsAction' });
    await expect(h.syncAgenda()).rejects.toThrow(/Personnel.*403/);
    expect(agendaRange(h.db, '2026-11-02', '2026-11-09').map((i) => i.id)).toEqual(['reunion']);
    expect(undatedTasks(h.db).map((t) => t.id)).toEqual(['t1']);
    expect(eventsSince(h.db).filter((e) => e.type === 'agenda.changed')).toHaveLength(1);
  });

  it('a task list in error does not stop the others', async () => {
    const h = await brokenHarness('/lists/list1/tasks');
    h.agenda.addList('list2', 'Courses');
    h.agenda.putTask('list1', { id: 't1', title: 'Rendre le rapport', status: 'needsAction' });
    h.agenda.putTask('list2', { id: 't2', title: 'Pain', status: 'needsAction' });
    await expect(h.syncAgenda()).rejects.toThrow(/Mes tâches.*403/);
    expect(undatedTasks(h.db).map((t) => t.id)).toEqual(['t2']);
  });
});
