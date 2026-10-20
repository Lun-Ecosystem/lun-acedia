import { describe, expect, it } from 'vitest';
import { getStoredMessage } from '../gmail/store.ts';
import { makeAgendaHarness } from '../testing/agenda-harness.ts';
import { message } from '../testing/fake-gmail.ts';
import { setPaused } from './state.ts';

const NAMES = [
  'mail.search',
  'mail.read',
  'mail.file',
  'mail.trash',
  'mail.archive',
  'mail.tags',
  'mail.validate',
  'mail.correct',
  'agenda.list',
  'event.create',
  'event.update',
  'event.delete',
  'task.create',
  'task.update',
  'task.complete',
  'task.delete',
];

async function setup() {
  const h = await makeAgendaHarness();
  h.gmail.deliver(message({ id: 'm1', subject: 'Rendu décalé' }));
  await h.sync();
  await h.syncAgenda();
  const act = (name: string, input: unknown = {}) => h.call('POST', `/lun/v1/actions/${name}`, input);
  return { h, act };
}

describe('contract actions', () => {
  it('lists the 16 actions, each with an object JSON Schema', async () => {
    const { h } = await setup();
    const { actions } = (await h.call('GET', '/lun/v1/actions')).body as {
      actions: { name: string; description: string; input: { type: string } }[];
    };
    expect(actions.map((a) => a.name).sort()).toEqual([...NAMES].sort());
    for (const a of actions) {
      expect(a.input.type).toBe('object');
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it('refuses to file into a label that is not a box (400)', async () => {
    const { act } = await setup();
    const res = await act('mail.file', { id: 'm1', boxId: 'INBOX' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('boîte');
  });

  it('files a mail into a box, as the front does', async () => {
    const { h, act } = await setup();
    const box = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
    const res = await act('mail.file', { id: 'm1', boxId: box });
    expect(res.body.ok).toBe(true);
    expect(getStoredMessage(h.db, 'm1')?.labels).toContain(box);
  });

  it('reads a mail as text, and answers ok:false for an unknown id', async () => {
    const { act } = await setup();
    const read = await act('mail.read', { id: 'm1' });
    expect(read.body).toMatchObject({
      ok: true,
      result: { id: 'm1', subject: 'Rendu décalé', text: 'Bonjour' },
    });
    expect(read.body.result.html).toBeUndefined();
    const unknown = await act('mail.read', { id: 'nope' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.ok).toBe(false);
    expect(typeof unknown.body.error).toBe('string');
  });

  it('searches the mails', async () => {
    const { act } = await setup();
    const res = await act('mail.search', { q: 'décalé' });
    expect(res.body.result.items.map((m: { id: string }) => m.id)).toEqual(['m1']);
  });

  it('runs a requested action even while paused', async () => {
    const { h, act } = await setup();
    h.agenda.putTask('list1', { id: 't1', title: 'Rendre le rapport', status: 'needsAction' });
    await h.syncAgenda();
    setPaused(h.db, true);
    const res = await act('task.complete', { listId: 'list1', id: 't1' });
    expect(res.body).toMatchObject({ ok: true, result: { id: 't1', done: true } });
    expect(h.agenda.task('list1', 't1')?.status).toBe('completed');
  });

  it('creates an event in the main calendar and a task in the first list by default', async () => {
    const { h, act } = await setup();
    const event = await act('event.create', {
      title: 'Dentiste',
      start: '2026-11-06T15:00:00.000Z',
      end: '2026-11-06T15:30:00.000Z',
    });
    expect(event.body.result).toMatchObject({ calendarId: 'primary', title: 'Dentiste', allDay: false });
    const task = await act('task.create', { title: 'Appeler la banque', due: '2026-11-04' });
    expect(task.body.result).toMatchObject({ listId: 'list1', due: '2026-11-04' });
    const listed = await act('agenda.list', { from: '2026-11-02', to: '2026-11-09' });
    expect(listed.body.result.items.map((i: { title: string }) => i.title).sort()).toEqual([
      'Appeler la banque',
      'Dentiste',
    ]);
    expect(h.agenda.event('primary', event.body.result.id)).toBeDefined();
  });
});
