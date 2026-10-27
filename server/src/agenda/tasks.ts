import type { DatabaseSync } from 'node:sqlite';
import { emitEvent } from '../contract/events.ts';
import { NotFoundError } from '../gmail/actions.ts';
import { getSyncState, setSyncState } from '../gmail/store.ts';
import type { SyncDeps } from '../gmail/sync.ts';
import { GoogleApiError } from '../google/client.ts';
import type { AgendaTask } from '../types.ts';

export const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

interface GoogleTask {
  id: string;
  title?: string;
  status?: 'needsAction' | 'completed';
  /** RFC 3339, but only the date part means something. */
  due?: string;
  notes?: string;
  deleted?: boolean;
}

interface Row {
  list_id: string;
  id: string;
  title: string;
  due: string | null;
  done: number;
  notes: string | null;
}

const tasksUrl = (listId: string) => `${TASKS_API}/lists/${encodeURIComponent(listId)}/tasks`;

export function toTask(r: Row): AgendaTask {
  const t: AgendaTask = { kind: 'task', id: r.id, listId: r.list_id, title: r.title, done: r.done === 1 };
  if (r.due) t.due = r.due;
  if (r.notes) t.notes = r.notes;
  return t;
}

export function getTask(db: DatabaseSync, listId: string, id: string): AgendaTask | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE list_id = ? AND id = ?').get(listId, id) as
    Row | undefined;
  return row ? toTask(row) : undefined;
}

/** Tasks due from `firstDay` to `lastDay` included, days as `AAAA-MM-JJ`. */
export function tasksDueBetween(db: DatabaseSync, firstDay: string, lastDay: string): AgendaTask[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE due >= ? AND due <= ? ORDER BY due, title')
    .all(firstDay, lastDay) as unknown as Row[];
  return rows.map(toTask);
}

/** Every task of every list, done ones included (the tasks page groups them itself). */
export function allTasks(db: DatabaseSync): AgendaTask[] {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY due IS NULL, due, title').all() as unknown as Row[];
  return rows.map(toTask);
}

/** Open tasks without a due date. */
export function undatedTasks(db: DatabaseSync): AgendaTask[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE due IS NULL AND done = 0 ORDER BY title')
    .all() as unknown as Row[];
  return rows.map(toTask);
}

/** Stores a task as Google returns it; true when the cache changed. */
function upsertTask(db: DatabaseSync, listId: string, t: GoogleTask): boolean {
  const values = [
    t.title ?? '',
    t.due ? t.due.slice(0, 10) : null,
    t.status === 'completed' ? 1 : 0,
    t.notes ?? null,
  ] as const;
  const before = db
    .prepare('SELECT title, due, done, notes FROM tasks WHERE list_id = ? AND id = ?')
    .get(listId, t.id);
  db.prepare(
    `INSERT INTO tasks (list_id, id, title, due, done, notes) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(list_id, id) DO UPDATE SET title = excluded.title, due = excluded.due, done = excluded.done,
       notes = excluded.notes`,
  ).run(listId, t.id, ...values);
  return JSON.stringify(before ? Object.values(before) : null) !== JSON.stringify(values);
}

function removeTask(db: DatabaseSync, listId: string, id: string): boolean {
  return db.prepare('DELETE FROM tasks WHERE list_id = ? AND id = ?').run(listId, id).changes > 0;
}

async function pullList(deps: SyncDeps, listId: string): Promise<number> {
  const since = getSyncState(deps.db, `tasks:${listId}`);
  const startedAt = deps.now().toISOString();
  let changes = 0;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      showCompleted: 'true',
      showDeleted: 'true',
      showHidden: 'true',
      maxResults: '100',
    });
    if (since) params.set('updatedMin', since);
    if (pageToken) params.set('pageToken', pageToken);
    const page = await deps.google.request<{ items?: GoogleTask[]; nextPageToken?: string }>(
      'GET',
      `${tasksUrl(listId)}?${params}`,
    );
    for (const t of page.items ?? []) {
      if (t.deleted) changes += removeTask(deps.db, listId, t.id) ? 1 : 0;
      else changes += upsertTask(deps.db, listId, t) ? 1 : 0;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  setSyncState(deps.db, `tasks:${listId}`, startedAt);
  return changes;
}

/** Syncs every task list; returns how many cached tasks changed. */
export async function syncTasks(deps: SyncDeps): Promise<number> {
  const lists: { id: string; title?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const page = await deps.google.request<{
      items?: { id: string; title?: string }[];
      nextPageToken?: string;
    }>(
      'GET',
      `${TASKS_API}/users/@me/lists${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`,
    );
    lists.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (lists[0]) setSyncState(deps.db, 'tasks:main', lists[0].id);
  let changes = 0;
  const known = (deps.db.prepare('SELECT id FROM task_lists').all() as { id: string }[]).map((r) => r.id);
  for (const id of known.filter((id) => !lists.some((l) => l.id === id))) {
    deps.db.prepare('DELETE FROM task_lists WHERE id = ?').run(id);
    deps.db.prepare('DELETE FROM sync_state WHERE key = ?').run(`tasks:${id}`);
    changes += Number(deps.db.prepare('DELETE FROM tasks WHERE list_id = ?').run(id).changes);
  }
  for (const l of lists) {
    deps.db
      .prepare(
        'INSERT INTO task_lists (id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title',
      )
      .run(l.id, l.title ?? '');
    changes += await pullList(deps, l.id);
  }
  return changes;
}

/** The default task list (the first one Google returns). */
export const mainTaskList = (db: DatabaseSync) => getSyncState(db, 'tasks:main');

export function listTaskLists(db: DatabaseSync): { id: string; title: string }[] {
  return db.prepare('SELECT id, title FROM task_lists ORDER BY title').all() as {
    id: string;
    title: string;
  }[];
}

export interface TaskInput {
  title: string;
  /** `AAAA-MM-JJ`, or `null` to remove the due date. */
  due?: string | null;
  notes?: string;
  done?: boolean;
}

function toGoogle(input: Partial<TaskInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.notes !== undefined) out.notes = input.notes;
  if (input.due !== undefined) out.due = input.due === null ? null : `${input.due}T00:00:00.000Z`;
  if (input.done === true) out.status = 'completed';
  if (input.done === false) Object.assign(out, { status: 'needsAction', completed: null });
  return out;
}

/** A write from Acedia changed the cache: said like a sync, so the counters and other screens read again. */
const changed = (deps: SyncDeps) =>
  emitEvent(
    deps.db,
    { type: 'agenda.changed', importance: 'info', title: 'Agenda mis à jour', data: { changes: 1 } },
    deps.now(),
  );

async function write(
  deps: SyncDeps,
  method: string,
  url: string,
  body?: unknown,
): Promise<GoogleTask | undefined> {
  try {
    return await deps.google.request<GoogleTask | undefined>(method, url, body);
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) throw new NotFoundError('Tâche introuvable');
    throw err;
  }
}

export async function createTask(deps: SyncDeps, listId: string, input: TaskInput): Promise<AgendaTask> {
  const t = (await write(deps, 'POST', tasksUrl(listId), toGoogle(input)))!;
  upsertTask(deps.db, listId, t);
  changed(deps);
  return getTask(deps.db, listId, t.id)!;
}

export async function updateTask(
  deps: SyncDeps,
  listId: string,
  id: string,
  patch: Partial<TaskInput>,
): Promise<AgendaTask> {
  const t = (await write(deps, 'PATCH', `${tasksUrl(listId)}/${encodeURIComponent(id)}`, toGoogle(patch)))!;
  upsertTask(deps.db, listId, t);
  changed(deps);
  return getTask(deps.db, listId, t.id)!;
}

export async function deleteTask(deps: SyncDeps, listId: string, id: string): Promise<void> {
  await write(deps, 'DELETE', `${tasksUrl(listId)}/${encodeURIComponent(id)}`);
  removeTask(deps.db, listId, id);
  changed(deps);
}
