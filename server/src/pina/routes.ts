import { Hono } from 'hono';
import { z } from 'zod';
import { ask, editCard, expireCards, refuseCard, resume, runCard, undoCard, type PinaDeps } from './agent.ts';
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

const Context = z.object({
  screen: z.enum(['mail', 'pending', 'agenda', 'tasks', 'journal', 'settings', 'compose']),
  mailId: z.string().max(200).optional(),
  day: z.string().max(200).optional(),
  listId: z.string().max(200).optional(),
  draftId: z.string().max(200).optional(),
});
const Message = z.object({ text: z.string().min(1).max(4000), context: Context });
const Decision = z.object({ decision: z.enum(['accept', 'refuse']), input: z.unknown().optional() });
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
    const card = getCard(deps.db, id);
    if (!card) return c.json({ error: 'Carte inconnue' }, 404);
    const { decision, input } = parsed.data;
    const today = dayOf(deps.clock());
    // Yesterday's card is expired even if the daily tidy has not run: nothing runs for it.
    if (card.day !== today) {
      if (card.status !== 'pending' && card.status !== 'expired')
        return c.json({ error: 'Carte déjà décidée' }, 409);
      expireCards(deps.db, today);
      return c.json({ error: 'Carte expirée' }, 409);
    }
    if (decision === 'accept' && input !== undefined) {
      const edited = editCard(deps, id, input);
      if (!edited.ok) return c.json({ error: edited.error }, edited.status);
    }
    const decided =
      decision === 'accept'
        ? await runCard(deps, id)
        : refuseCard(deps, id)
          ? getCard(deps.db, id)
          : undefined;
    if (!decided) return c.json({ error: 'Carte déjà décidée' }, 409);
    // After the decision, never inside the queue: the loop goes on with its outcome.
    await resume(deps, id);
    return c.json({ card: getCard(deps.db, id), ...thread(card.day) });
  });

  r.post('/cards/:id/undo', async (c) => {
    const id = Number(c.req.param('id'));
    const out = await undoCard(deps, id);
    if (!out) return c.json({ error: 'Rien à annuler' }, 409);
    if (!out.ok) return c.json({ error: out.error }, 409);
    return c.json({ card: getCard(deps.db, id), result: out.result });
  });

  r.get('/settings', (c) => c.json(pinaSettings(deps.db)));
  r.put('/settings', async (c) => {
    try {
      putPinaSettings(deps.db, (await body(c)) as never);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(pinaSettings(deps.db));
  });
  return r;
}
