import { describe, expect, it } from 'vitest';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';
import { undatedTasks } from './unified.ts';

describe('tasks sync', () => {
  it('fetches every list, then only what changed since, deletions included', async () => {
    const h = await makeAgendaHarness();
    h.agenda.addList('list2', 'Courses');
    h.agenda.putTask('list1', { id: 't1', title: 'Rendre le rapport', status: 'needsAction' });
    h.agenda.putTask('list2', { id: 't2', title: 'Pain', status: 'needsAction' });
    await h.syncAgenda();
    expect(
      undatedTasks(h.db)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t1', 't2']);

    h.advance(60_000);
    h.agenda.putTask('list2', { id: 't2', title: 'Pain', status: 'needsAction', deleted: true });
    await h.syncAgenda();
    expect(undatedTasks(h.db).map((t) => t.id)).toEqual(['t1']);
    const second = h.calls.filter((c) => c.url.includes('/lists/list2/tasks')).at(-1)!;
    const q = new URL(second.url).searchParams;
    expect(q.get('updatedMin')).toBe('2026-11-02T08:00:00.000Z');
    expect(q.get('showDeleted')).toBe('true');
    expect(q.get('showHidden')).toBe('true');
  });

  it('lists every task of every list with ?all=1, done and dated ones included', async () => {
    const h = await makeAgendaHarness();
    h.agenda.addList('list2', 'Courses');
    h.agenda.putTask('list1', { id: 't1', title: 'Rendre le rapport', status: 'needsAction' });
    h.agenda.putTask('list2', {
      id: 't2',
      title: 'Pain',
      status: 'completed',
      due: '2026-11-01T00:00:00.000Z',
    });
    h.agenda.putTask('list1', {
      id: 't3',
      title: 'Banque',
      status: 'needsAction',
      due: '2026-11-05T00:00:00.000Z',
    });
    await h.syncAgenda();
    const res = await h.call('GET', '/api/tasks?all=1');
    expect(res.body.items.map((t: { id: string; done: boolean }) => [t.id, t.done])).toEqual([
      ['t2', true],
      ['t3', false],
      ['t1', false],
    ]);
    expect((await h.call('GET', '/api/tasks')).body.items.map((t: { id: string }) => t.id)).toEqual(['t1']);
  });

  it('a task ticked in Acedia is completed on Google and in the cache', async () => {
    const h = await makeAgendaHarness();
    h.agenda.putTask('list1', { id: 't1', title: 'Rendre le rapport', status: 'needsAction' });
    await h.syncAgenda();
    const res = await h.call('POST', '/api/tasks/list1/t1/complete');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'task', id: 't1', done: true });
    const patch = h.calls.find((c) => c.method === 'PATCH' && c.url.includes('/lists/list1/tasks/t1'))!;
    expect(JSON.parse(patch.body!)).toEqual({ status: 'completed' });
    expect(h.agenda.task('list1', 't1')?.status).toBe('completed');
    expect(undatedTasks(h.db)).toEqual([]);
    expect((await h.call('GET', '/api/tasks?undated=1')).body.items).toEqual([]);
  });

  it('creates, renames and deletes a task from Acedia', async () => {
    const h = await makeAgendaHarness();
    await h.syncAgenda();
    const created = await h.call('POST', '/api/tasks/list1', { title: 'Appeler la banque' });
    const id = created.body.id as string;
    expect((await h.call('GET', '/api/tasks?undated=1')).body.items.map((t: { id: string }) => t.id)).toEqual(
      [id],
    );
    const renamed = await h.call('PATCH', `/api/tasks/list1/${id}`, {
      title: 'Appeler la banque (prêt)',
      due: '2026-11-04',
    });
    expect(renamed.body).toMatchObject({ title: 'Appeler la banque (prêt)', due: '2026-11-04' });
    expect(h.agenda.task('list1', id)?.due).toBe('2026-11-04T00:00:00.000Z');
    expect((await h.call('DELETE', `/api/tasks/list1/${id}`)).status).toBe(200);
    expect((await h.call('GET', '/api/agenda?from=2026-11-02&to=2026-11-09')).body.items).toEqual([]);
  });
});
