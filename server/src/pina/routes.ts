import { Hono } from 'hono';
import { z } from 'zod';
import { spentToday } from '../llm/models.ts';
import { ask, decideCard, undoCard, type PinaDeps } from './agent.ts';
import {
  cardsOf,
  dayOf,
  days,
  getCard,
  messagesOf,
  pendingCount,
  pinaSettings,
  putPinaSettings,
} from './store.ts';

// The ids go into the system prompt: no line break, nothing but an id's characters.
const ContextId = z
  .string()
  .regex(/^[\w-]{1,200}$/)
  .optional();
const Context = z.object({
  screen: z.enum(['mail', 'pending', 'agenda', 'tasks', 'journal', 'settings', 'compose']),
  mailId: ContextId,
  day: ContextId,
  listId: ContextId,
  draftId: ContextId,
});
const Message = z.object({ text: z.string().min(1).max(4000), context: Context });
const MAX_INPUT = 20_000;
export const Decision = z.object({
  decision: z.enum(['accept', 'refuse']),
  input: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || JSON.stringify(v).length <= MAX_INPUT, 'Entrée trop longue'),
});
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Pina over HTTP; mounted under `/api/pina`, behind the device token. */
export function pinaRoutes(deps: PinaDeps): Hono {
  const r = new Hono();
  const thread = (day: string) => ({
    day,
    messages: messagesOf(deps.db, day),
    cards: cardsOf(deps.db, day),
    pending: pendingCount(deps.db, day),
  });
  const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => undefined);

  r.get('/today', (c) => c.json(thread(dayOf(deps.clock()))));
  r.get('/days', (c) => c.json({ days: days(deps.db) }));
  r.get('/days/:day', (c) => {
    const day = c.req.param('day');
    return DAY.test(day) ? c.json(thread(day)) : c.json({ error: 'Jour attendu : AAAA-MM-JJ' }, 400);
  });

  r.post('/messages', async (c) => {
    const parsed = Message.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { text, context } = parsed.data;
    await ask(deps, text, context as Parameters<typeof ask>[2]);
    return c.json(thread(dayOf(deps.clock())));
  });

  r.post('/cards/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const parsed = Decision.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const out = await decideCard(deps, id, parsed.data.decision, parsed.data.input);
    if (!out.ok) return c.json({ error: out.error }, out.status);
    return c.json({ card: out.card, ...thread(out.card.day) });
  });

  r.post('/cards/:id/undo', async (c) => {
    const id = Number(c.req.param('id'));
    const out = await undoCard(deps, id);
    if (!out) return c.json({ error: 'Rien à annuler' }, 409);
    if (!out.ok) return c.json({ error: out.error }, 409);
    return c.json({ card: getCard(deps.db, id), result: out.result });
  });

  // Today's spend rides with the settings: the page shows it beside the daily cap.
  const settings = () => ({
    ...pinaSettings(deps.db),
    spentTodayUsd: spentToday(deps.db, 'pina', deps.clock()),
  });
  r.get('/settings', (c) => c.json(settings()));
  r.put('/settings', async (c) => {
    try {
      putPinaSettings(deps.db, (await body(c)) as never);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(settings());
  });
  return r;
}
