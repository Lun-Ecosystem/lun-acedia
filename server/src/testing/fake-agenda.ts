import type { RecordedCall } from './fake-fetch.ts';

export const CALENDAR = 'https://www.googleapis.com/calendar/v3';
export const TASKS = 'https://tasks.googleapis.com/tasks/v1';

export interface FakeEvent {
  id: string;
  status?: 'confirmed' | 'cancelled';
  summary?: string;
  location?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
}

export interface FakeTask {
  id: string;
  title: string;
  status: 'needsAction' | 'completed';
  due?: string;
  notes?: string;
  deleted?: boolean;
  updated: string;
}

interface Calendar {
  id: string;
  summary: string;
  selected?: boolean;
  accessRole: string;
  defaultReminders: { method: string; minutes: number }[];
  /** Each event with the version at which it last changed (deleted ones stay as `cancelled`). */
  events: Map<string, { event: FakeEvent; version: number }>;
}

const notFound = { status: 404, json: { error: { message: 'Not Found' } } };

/** An in-memory Google Calendar and Google Tasks, with real sync tokens and `updatedMin`. */
export class FakeAgenda {
  private version = 1;
  private minVersion = 0;
  readonly calendars = new Map<string, Calendar>();
  readonly lists = new Map<string, { id: string; title: string; tasks: Map<string, FakeTask> }>();
  private seq = 0;

  private readonly now: () => Date;

  constructor(now: () => Date) {
    this.now = now;
    this.addCalendar('primary', 'Personnel', { defaultReminders: [{ method: 'popup', minutes: 30 }] });
    this.addList('list1', 'Mes tâches');
  }

  addCalendar(
    id: string,
    summary: string,
    opts: {
      selected?: boolean;
      accessRole?: string;
      defaultReminders?: { method: string; minutes: number }[];
    } = {},
  ): void {
    this.calendars.set(id, {
      id,
      summary,
      selected: opts.selected ?? true,
      accessRole: opts.accessRole ?? 'owner',
      defaultReminders: opts.defaultReminders ?? [],
      events: new Map(),
    });
  }

  addList(id: string, title: string): void {
    this.lists.set(id, { id, title, tasks: new Map() });
  }

  /** Creates or replaces an event on Google's side. */
  putEvent(calendarId: string, event: FakeEvent): void {
    this.version += 1;
    this.calendars.get(calendarId)!.events.set(event.id, {
      event: structuredClone({ status: 'confirmed', ...event }),
      version: this.version,
    });
  }

  cancelEvent(calendarId: string, id: string): void {
    const entry = this.calendars.get(calendarId)!.events.get(id)!;
    this.putEvent(calendarId, { ...entry.event, status: 'cancelled' });
  }

  /** Google forgot the old sync tokens: using one answers 410. */
  expireSyncTokens(): void {
    this.minVersion = this.version;
  }

  putTask(listId: string, task: Omit<FakeTask, 'updated'>): void {
    this.lists
      .get(listId)!
      .tasks.set(task.id, { ...structuredClone(task), updated: this.now().toISOString() });
  }

  task(listId: string, id: string): FakeTask | undefined {
    return this.lists.get(listId)?.tasks.get(id);
  }

  event(calendarId: string, id: string): FakeEvent | undefined {
    return this.calendars.get(calendarId)?.events.get(id)?.event;
  }

  handler = (call: RecordedCall) => {
    if (call.url.startsWith(CALENDAR)) return this.calendar(call);
    if (call.url.startsWith(TASKS)) return this.tasks(call);
    return undefined;
  };

  private calendar(call: RecordedCall) {
    const url = new URL(call.url);
    const path = url.pathname.replace('/calendar/v3', '');
    const q = url.searchParams;
    const body = call.body ? (JSON.parse(call.body) as Partial<FakeEvent>) : {};

    if (call.method === 'GET' && path === '/users/me/calendarList') {
      return {
        json: {
          items: [...this.calendars.values()].map(
            ({ id, summary, selected, accessRole, defaultReminders }) => ({
              id,
              summary,
              accessRole,
              ...(id === 'primary' ? { primary: true } : {}),
              ...(selected ? { selected } : {}),
              defaultReminders,
            }),
          ),
        },
      };
    }
    const list = path.match(/^\/calendars\/([^/]+)\/events$/);
    const one = path.match(/^\/calendars\/([^/]+)\/events\/([^/]+)$/);
    const cal = this.calendars.get(decodeURIComponent((list ?? one)?.[1] ?? ''));
    if ((list || one) && !cal) return notFound;

    if (call.method === 'GET' && list) {
      const token = q.get('syncToken');
      if (token && (q.has('timeMin') || q.has('timeMax'))) return { status: 400, json: {} };
      const since = token ? Number(token.slice(1)) : 0;
      if (token && since < this.minVersion) return { status: 410, json: { error: { message: 'Gone' } } };
      const items = [...cal!.events.values()]
        .filter((e) => e.version > since && (token || e.event.status !== 'cancelled'))
        .map((e) => e.event);
      // Two items per page, to exercise the paging.
      const offset = Number(q.get('pageToken') ?? 0);
      const page = items.slice(offset, offset + 2);
      return {
        json:
          offset + 2 < items.length
            ? { items: page, nextPageToken: String(offset + 2) }
            : { items: page, nextSyncToken: `v${this.version}` },
      };
    }
    if (call.method === 'POST' && list) {
      const event = { ...body, id: `ev${++this.seq}` } as FakeEvent;
      this.putEvent(cal!.id, event);
      return { json: this.event(cal!.id, event.id) };
    }
    if (one) {
      const id = decodeURIComponent(one[2]!);
      const current = this.event(cal!.id, id);
      if (!current || current.status === 'cancelled') return notFound;
      if (call.method === 'PATCH') {
        this.putEvent(cal!.id, { ...current, ...body, id });
        return { json: this.event(cal!.id, id) };
      }
      if (call.method === 'DELETE') {
        this.cancelEvent(cal!.id, id);
        return { status: 204 };
      }
    }
    return undefined;
  }

  private tasks(call: RecordedCall) {
    const url = new URL(call.url);
    const path = url.pathname.replace('/tasks/v1', '');
    const q = url.searchParams;
    const body = call.body ? (JSON.parse(call.body) as Partial<FakeTask>) : {};

    if (call.method === 'GET' && path === '/users/@me/lists') {
      return { json: { items: [...this.lists.values()].map(({ id, title }) => ({ id, title })) } };
    }
    const all = path.match(/^\/lists\/([^/]+)\/tasks$/);
    const one = path.match(/^\/lists\/([^/]+)\/tasks\/([^/]+)$/);
    const list = this.lists.get(decodeURIComponent((all ?? one)?.[1] ?? ''));
    if ((all || one) && !list) return notFound;

    if (call.method === 'GET' && all) {
      const min = q.get('updatedMin');
      const showDeleted = q.get('showDeleted') === 'true';
      const items = [...list!.tasks.values()].filter(
        (t) => (!min || t.updated >= min) && (showDeleted || !t.deleted),
      );
      return { json: { items } };
    }
    if (call.method === 'POST' && all) {
      const id = `task${++this.seq}`;
      this.putTask(list!.id, { status: 'needsAction', title: '', ...body, id });
      return { json: this.task(list!.id, id) };
    }
    if (one) {
      const id = decodeURIComponent(one[2]!);
      const current = list!.tasks.get(id);
      if (!current || current.deleted) return notFound;
      if (call.method === 'PATCH') {
        this.putTask(list!.id, { ...current, ...body, id });
        return { json: this.task(list!.id, id) };
      }
      if (call.method === 'DELETE') {
        this.putTask(list!.id, { ...current, deleted: true });
        return { status: 204 };
      }
    }
    return undefined;
  }
}
