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

const NEW_NAMES = [
  'mail.list',
  'mail.untrash',
  'mail.spam',
  'mail.markRead',
  'label.list',
  'label.create',
  'label.setRole',
  'calendar.list',
  'tasklist.list',
  'task.list',
  'journal.list',
  'journal.undo',
  'rule.list',
  'rule.create',
  'rule.update',
  'rule.delete',
  'stats.today',
  'draft.read',
  'draft.create',
  'draft.update',
  'draft.delete',
  'day.digest',
];

const EFFECTS: Record<string, string> = {
  'mail.search': 'read',
  'mail.read': 'read',
  'agenda.list': 'read',
  'event.delete': 'delete',
  'task.delete': 'delete',
  'rule.delete': 'delete',
  'mail.list': 'read',
  'label.list': 'read',
  'calendar.list': 'read',
  'tasklist.list': 'read',
  'task.list': 'read',
  'journal.list': 'read',
  'rule.list': 'read',
  'draft.read': 'read',
  'draft.delete': 'delete',
  'stats.today': 'read',
  'day.digest': 'read',
};

async function setup() {
  const h = await makeAgendaHarness();
  h.gmail.deliver(message({ id: 'm1', subject: 'Rendu décalé' }));
  await h.sync();
  await h.syncAgenda();
  const act = (name: string, input: unknown = {}) => h.call('POST', `/lun/v1/actions/${name}`, input);
  return { h, act };
}

describe('contract actions', () => {
  it('has draft.create/update/delete and no action name containing "send"', async () => {
    const { h } = await setup();
    const { actions } = (await h.call('GET', '/lun/v1/actions')).body as { actions: { name: string }[] };
    const names = actions.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['draft.create', 'draft.update', 'draft.delete']));
    expect(names.filter((n) => /send/i.test(n))).toEqual([]);
  });

  it('lists the 38 actions, each with an object JSON Schema', async () => {
    const { h } = await setup();
    const { actions } = (await h.call('GET', '/lun/v1/actions')).body as {
      actions: { name: string; description: string; input: { type: string } }[];
    };
    expect(actions.map((a) => a.name).sort()).toEqual([...NAMES, ...NEW_NAMES].sort());
    for (const a of actions) {
      expect(a.input.type).toBe('object');
      expect(a.description.length).toBeGreaterThan(0);
      // The agent is neutral: no user is named to the model.
      expect(a.description).not.toMatch(/CrOliX/);
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

  it('every action has an effect, delete only for deletions and reads', async () => {
    const { h } = await setup();
    const { actions } = (await h.call('GET', '/lun/v1/actions')).body as {
      actions: { name: string; effect: string }[];
    };
    expect(actions).toHaveLength(NAMES.length + NEW_NAMES.length);
    for (const a of actions) expect(a.effect, a.name).toBe(EFFECTS[a.name] ?? 'write');
    expect(actions.find((a) => a.name === 'rule.delete')?.effect).toBe('delete');
    expect(actions.find((a) => a.name === 'event.delete')?.effect).toBe('delete');
  });
});

type Call = [method: string, path: string, body?: unknown];
interface Case {
  name: string;
  input: (ctx: Ctx) => unknown;
  route: (ctx: Ctx) => Call;
}
interface Ctx {
  box: string;
  journalId: number;
  ruleId: number;
}

/** Same state in two fresh servers: the screen route on one, the action on the other. */
async function prepared() {
  const { h, act } = await setup();
  const box = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
  const filed = await h.call('POST', '/api/mail/m1/file', { boxId: box });
  const rule = await h.call('POST', '/api/rules', { field: 'from', op: 'contains', value: 'x', boxId: box });
  const ctx: Ctx = { box, journalId: filed.body.journalId as number, ruleId: rule.body.id as number };
  return { h, act, ctx };
}

const CASES: Case[] = [
  { name: 'mail.list', input: () => ({ view: 'inbox' }), route: () => ['GET', '/api/mail?view=inbox'] },
  {
    name: 'mail.list',
    input: (c) => ({ view: c.box }),
    route: (c) => ['GET', `/api/mail?view=box:${c.box}`],
  },
  { name: 'mail.untrash', input: () => ({ id: 'm1' }), route: () => ['POST', '/api/mail/m1/untrash', {}] },
  { name: 'mail.spam', input: () => ({ id: 'm1' }), route: () => ['POST', '/api/mail/m1/spam', {}] },
  {
    name: 'mail.markRead',
    input: () => ({ id: 'm1', read: true }),
    route: () => ['POST', '/api/mail/m1/read', { read: true }],
  },
  { name: 'label.list', input: () => ({}), route: () => ['GET', '/api/labels'] },
  {
    name: 'label.create',
    input: () => ({ name: 'Banque', role: 'tag' }),
    route: () => ['POST', '/api/labels', { name: 'Banque', role: 'tag' }],
  },
  {
    name: 'label.setRole',
    input: (c) => ({ id: c.box, role: 'tag' }),
    route: (c) => ['PATCH', `/api/labels/${c.box}`, { role: 'tag' }],
  },
  { name: 'calendar.list', input: () => ({}), route: () => ['GET', '/api/calendars'] },
  { name: 'tasklist.list', input: () => ({}), route: () => ['GET', '/api/task-lists'] },
  { name: 'task.list', input: () => ({}), route: () => ['GET', '/api/tasks?all=1'] },
  { name: 'journal.list', input: () => ({}), route: () => ['GET', '/api/journal'] },
  {
    name: 'journal.undo',
    input: (c) => ({ id: c.journalId }),
    route: (c) => ['POST', `/api/journal/${c.journalId}/undo`, {}],
  },
  { name: 'rule.list', input: () => ({}), route: () => ['GET', '/api/rules'] },
  {
    name: 'rule.create',
    input: (c) => ({ field: 'subject', op: 'contains', value: 'facture', boxId: c.box }),
    route: (c) => [
      'POST',
      '/api/rules',
      { field: 'subject', op: 'contains', value: 'facture', boxId: c.box },
    ],
  },
  {
    name: 'rule.update',
    input: (c) => ({ id: c.ruleId, value: 'y', enabled: false }),
    route: (c) => ['PATCH', `/api/rules/${c.ruleId}`, { value: 'y', enabled: false }],
  },
  {
    name: 'rule.delete',
    input: (c) => ({ id: c.ruleId }),
    route: (c) => ['DELETE', `/api/rules/${c.ruleId}`],
  },
  { name: 'stats.today', input: () => ({}), route: () => ['GET', '/api/stats/today'] },
];

describe('new actions run the same function as their screen route', () => {
  it.each(CASES)('$name', async (c) => {
    const screen = await prepared();
    const [method, path, body] = c.route(screen.ctx);
    const expected = await screen.h.call(method, path, body);
    const core = await prepared();
    const got = await core.act(c.name, c.input(core.ctx));
    expect(got.body, JSON.stringify(c.input(core.ctx))).toMatchObject({ ok: true });
    expect(expected.status).toBe(200);
    // Journaled the same way: the same journalId in both fresh servers.
    expect(got.body.result).toEqual(expected.body);
  });
});

describe('catalog errors are answers, never a 500', () => {
  it('invalid input is a 400 with the schema message', async () => {
    const { act } = await setup();
    const res = await act('mail.read', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id');
  });

  it('an unknown mail.list view and an unknown label.setRole id are 400s', async () => {
    const { act } = await setup();
    expect((await act('mail.list', { view: 'nope' })).status).toBe(400);
    const role = await act('label.setRole', { id: 'nope', role: 'box' });
    expect(role.status).toBe(400);
    expect(role.body.error).toContain('nope');
  });

  it('a mail action journals like the screen, and undoing it twice is ok:false', async () => {
    const { h, act } = await setup();
    const box = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
    const filed = await act('mail.file', { id: 'm1', boxId: box });
    const journalId = filed.body.result.journalId as number;
    expect(typeof journalId).toBe('number');
    expect((await act('journal.undo', { id: journalId })).body.ok).toBe(true);
    const again = await act('journal.undo', { id: journalId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: false, error: 'Action déjà annulée' });
  });
});
