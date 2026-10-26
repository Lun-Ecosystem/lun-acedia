import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { requireToken } from '../contract/auth.ts';
import { BadRequestError } from '../gmail/actions.ts';
import type { GoogleClient } from '../google/client.ts';
import { answer } from '../triage/routes.ts';
import { stripUndefined } from '../util.ts';
import { createEvent, deleteEvent, listCalendars, updateEvent } from './calendar.ts';
import { allTasks, createTask, deleteTask, listTaskLists, undatedTasks, updateTask } from './tasks.ts';
import { isDateOrInstant, isDay } from './time.ts';
import { agendaRange } from './unified.ts';

const When = z.string().refine(isDateOrInstant, 'Date attendue (AAAA-MM-JJ ou ISO 8601)');
const Day = z.string().refine(isDay, 'Date attendue (AAAA-MM-JJ)');

const EventBody = z.object({
  title: z.string().trim().min(1),
  start: When,
  end: When,
  allDay: z.boolean(),
  location: z.string().optional(),
  reminders: z.array(z.number().int().min(0).max(40_320)).nullable().optional(),
});

const TaskBody = z.object({
  title: z.string().trim().min(1),
  due: Day.nullable().optional(),
  notes: z.string().optional(),
  done: z.boolean().optional(),
});

/** `/api/agenda`, `/api/calendars`, `/api/events`, `/api/task-lists` and `/api/tasks`. */
export function agendaRoutes(deps: AppDeps, google: GoogleClient | undefined): Hono {
  const r = new Hono();
  r.use('*', requireToken(deps.db));
  const sync = () => {
    if (!google) throw new BadRequestError('Google n’est pas configuré sur ce serveur');
    return { db: deps.db, google, now: deps.clock };
  };
  const parse = async <T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>) =>
    schema.safeParse(await c.req.json().catch(() => undefined));

  r.get('/agenda', (c) => {
    const range = z.object({ from: When, to: When }).safeParse(c.req.query());
    if (!range.success) return c.json({ error: range.error.message }, 400);
    return c.json({ items: agendaRange(deps.db, range.data.from, range.data.to) });
  });
  r.get('/calendars', (c) => c.json({ items: listCalendars(deps.db) }));
  r.get('/task-lists', (c) => c.json({ items: listTaskLists(deps.db) }));
  // `?all=1`: every task, done ones included; otherwise the open tasks without a date.
  r.get('/tasks', (c) =>
    c.json({ items: c.req.query('all') === '1' ? allTasks(deps.db) : undatedTasks(deps.db) }),
  );

  r.post('/events/:calendarId', async (c) => {
    const body = await parse(c, EventBody);
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return answer(c, () => createEvent(sync(), c.req.param('calendarId'), stripUndefined(body.data)));
  });
  r.patch('/events/:calendarId/:id', async (c) => {
    const body = await parse(c, EventBody.partial());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return answer(c, () =>
      updateEvent(sync(), c.req.param('calendarId'), c.req.param('id'), stripUndefined(body.data)),
    );
  });
  r.delete('/events/:calendarId/:id', (c) =>
    answer(c, async () => {
      await deleteEvent(sync(), c.req.param('calendarId'), c.req.param('id'));
      return { ok: true };
    }),
  );

  r.post('/tasks/:listId', async (c) => {
    const body = await parse(c, TaskBody);
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return answer(c, () => createTask(sync(), c.req.param('listId'), stripUndefined(body.data)));
  });
  r.patch('/tasks/:listId/:id', async (c) => {
    const body = await parse(c, TaskBody.partial());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return answer(c, () =>
      updateTask(sync(), c.req.param('listId'), c.req.param('id'), stripUndefined(body.data)),
    );
  });
  r.post('/tasks/:listId/:id/complete', async (c) => {
    const body = await parse(c, z.object({ done: z.boolean().default(true) }).default({ done: true }));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return answer(c, () =>
      updateTask(sync(), c.req.param('listId'), c.req.param('id'), { done: body.data.done }),
    );
  });
  r.delete('/tasks/:listId/:id', (c) =>
    answer(c, async () => {
      await deleteTask(sync(), c.req.param('listId'), c.req.param('id'));
      return { ok: true };
    }),
  );

  return r;
}
