import { Hono } from 'hono';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import type { AppDeps } from '../app.ts';
import { SATELLITE } from '../identity.ts';
import { DegradedError, InvalidInputError } from './actions.ts';
import { pair, recordPairingFailure, requireToken } from './auth.ts';
import { authorizationPage, exchangeAuthorizationCode, readAuthorizationRequest } from './authorize.ts';
import { costsSince } from './costs.ts';
import { ask, decideCard, expireCards, type PinaDeps } from '../pina/agent.ts';
import { cardText } from '../pina/lines.ts';
import { Context, Decision } from '../pina/routes.ts';
import { cardsOf, dayOf, getCard, messagesOf, type Card } from '../pina/store.ts';
import { spentToday } from '../llm/models.ts';
import type { ScreenContext } from '../types.ts';
import type { ContractCard, PinaCardStatus } from '../types.ts';
import { eventsSince, mailLink, subscribe, type LunEvent } from './events.ts';
import { getState, setPaused, statusOf } from './state.ts';

const HEARTBEAT_MS = 25_000;

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text);
}

/** The satellite contract v1 (`standards/contrat-satellite.md` in lun-docs). */
const STATUSES: PinaCardStatus[] = ['pending', 'done', 'refused', 'failed', 'expired'];
// Only « Modifier »'s input, with the size bound the app's route has.
const Accept = Decision.pick({ input: true });
// The core's context is Pina's own, every key optional; an unknown key is a mistake, not noise.
const Delegation = z.object({
  request: z.string().min(1).max(4000),
  context: Context.partial().strict().optional(),
});
const PAUSED = 'Acedia est en pause : je ne fais rien tant qu’elle n’est pas reprise.';

function toContractCard(db: AppDeps['db'], card: Card): ContractCard {
  const text = cardText(db, card);
  const mailId = (card.input as { id?: unknown } | null)?.id;
  return {
    id: String(card.id),
    action: card.action,
    effect: card.effect === 'delete' ? 'delete' : 'write',
    title: text.title,
    lines: text.fields.map((f) => `${f.label} : ${f.value}`),
    status: card.status,
    at: card.createdAt,
    ...(card.error ? { error: card.error } : {}),
    ...(card.action.startsWith('mail.') && mailId !== undefined ? { link: mailLink(mailId) } : {}),
  };
}

export function contractRoutes(deps: AppDeps, pina: PinaDeps): Hono {
  const { db, clock, actions } = deps;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const r = new Hono();

  r.post('/pair', async (c) => {
    let body: { code?: unknown; client?: unknown; code_verifier?: unknown };
    try {
      body = (await readJson(c.req.raw)) as typeof body;
    } catch {
      return c.json({ error: 'Corps JSON invalide' }, 400);
    }
    const byAuthorization = body.code_verifier !== undefined;
    let result: { token: string } | null = null;
    if (typeof body.code === 'string') {
      if (byAuthorization)
        result =
          typeof body.code_verifier === 'string'
            ? exchangeAuthorizationCode(db, body.code, body.code_verifier, clock())
            : null;
      // The code is shown « 482 917 »: its spaces (also U+00A0, U+202F) go, nothing else does.
      else
        result = pair(
          db,
          body.code.replace(/\s/g, ''),
          typeof body.client === 'string' ? body.client : 'client',
          clock(),
        );
    }
    if (!result) {
      recordPairingFailure(db, clock(), log);
      const error = byAuthorization
        ? 'Code d’autorisation invalide, déjà utilisé, expiré ou code_verifier faux'
        : 'Code d’appairage invalide, déjà utilisé ou expiré';
      return c.json({ error }, 401);
    }
    return c.json({ token: result.token, satellite: { ...SATELLITE, version: deps.version } });
  });

  // Public, like /pair: the front's page then tests its own device token.
  r.get('/authorize', (c) => {
    const read = readAuthorizationRequest(c.req.query());
    if ('error' in read) return c.text(read.error, 400);
    return c.redirect(authorizationPage(read.request), 302);
  });

  r.use('*', requireToken(db));

  r.get('/health', (c) => {
    const state = getState(db);
    const status = statusOf(state);
    // Degraded hides the pause in `status`: said apart, so a front can still offer to resume.
    const paused = status.status === 'degraded' && state.paused ? { paused: true } : {};
    return c.json({ ...status, ...paused, version: deps.version, agent: true });
  });

  r.get('/costs', (c) => {
    const raw = c.req.query('since');
    const since = raw ? new Date(raw) : new Date(0);
    if (Number.isNaN(since.getTime())) return c.json({ error: `Date illisible : ${raw}` }, 400);
    return c.json(costsSince(db, since, clock()));
  });

  r.post('/pause', (c) => {
    if (getState(db).paused) return c.json({ error: 'Déjà en pause' }, 409);
    setPaused(db, true);
    return c.json({ status: 'paused' });
  });

  r.post('/resume', (c) => {
    if (!getState(db).paused) return c.json({ error: 'Déjà actif' }, 409);
    setPaused(db, false);
    return c.json({ status: statusOf(getState(db)).status });
  });

  r.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: LunEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = subscribe(db, (e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      const send = (e: LunEvent) => stream.writeSSE({ id: e.id, event: e.type, data: JSON.stringify(e) });
      let last = c.req.header('last-event-id');
      for (const e of eventsSince(db, last)) {
        await send(e);
        last = e.id;
      }
      while (!stream.aborted) {
        const next = queue.shift();
        if (next) {
          if (Number(next.id) > Number(last ?? 0)) await send(next);
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, HEARTBEAT_MS);
        });
        wake = undefined;
        if (!queue.length && !stream.aborted) await stream.write(': ping\n\n');
      }
    }),
  );

  r.get('/cards', (c) => {
    const status = c.req.query('status') ?? 'pending';
    if (!STATUSES.includes(status as PinaCardStatus))
      return c.json({ error: `Statut inconnu : ${status}` }, 400);
    expireCards(db, dayOf(clock()));
    const rows = db.prepare('SELECT id FROM pina_cards WHERE status = ? ORDER BY id DESC').all(status);
    const cards = rows.map((x) => toContractCard(db, getCard(db, (x as { id: number }).id)!));
    return c.json({ cards });
  });

  // The card is decided once `decideCard` answers: a failure of the loop that resumes (the model's
  // turn) is logged, never turned into an error for a card that is already settled.
  const decide = async (id: string, decision: 'accept' | 'refuse', input?: unknown) => {
    try {
      return await decideCard(pina, Number(id), decision, input);
    } catch (err) {
      log(
        `Pina : reprise après la carte ${id} en échec : ${err instanceof Error ? err.message : String(err)}`,
      );
      const card = getCard(db, Number(id));
      return card
        ? { ok: true as const, card }
        : { ok: false as const, status: 404 as const, error: 'Carte inconnue' };
    }
  };

  r.post('/cards/:id/accept', async (c) => {
    let raw: unknown;
    try {
      raw = await readJson(c.req.raw);
    } catch {
      return c.json({ error: 'Corps JSON invalide' }, 400);
    }
    const parsed = Accept.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const out = await decide(c.req.param('id'), 'accept', parsed.data.input);
    if (!out.ok) return c.json({ error: out.error }, out.status);
    return c.json({ card: toContractCard(db, out.card) });
  });

  r.post('/cards/:id/refuse', async (c) => {
    const out = await decide(c.req.param('id'), 'refuse');
    if (!out.ok) return c.json({ error: out.error }, out.status);
    return c.json({ card: toContractCard(db, out.card) });
  });

  r.post('/agent', async (c) => {
    const parsed = Delegation.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const cost = (amount: number) => ({ currency: 'USD' as const, amount });
    // shortcut: refs empty until the core shows them, fill from the turn's read tools
    const refs: never[] = [];
    if (getState(db).paused) return c.json({ summary: PAUSED, cards: [], refs, cost: cost(0) });
    const before = spentToday(db, 'pina', clock());
    const context = { screen: 'mail', ...parsed.data.context } as ScreenContext;
    const turn = await ask(pina, parsed.data.request, context, { mode: 'validate' });
    const day = dayOf(clock());
    const summary = messagesOf(db, day)
      .filter(({ message: m }) => m.role === 'assistant' && (m as { turn?: number }).turn === turn)
      .at(-1)?.message;
    return c.json({
      summary: summary?.role === 'assistant' ? summary.text : '',
      cards: cardsOf(db, day)
        .filter((x) => x.turn === turn)
        .map((x) => toContractCard(db, x)),
      refs,
      cost: cost(spentToday(db, 'pina', clock()) - before),
    });
  });

  r.get('/actions', (c) => c.json({ actions: actions.list() }));

  r.post('/actions/:name', async (c) => {
    const entry = actions.get(c.req.param('name'));
    if (!entry) return c.json({ error: `Action inconnue : ${c.req.param('name')}` }, 404);
    let raw: unknown;
    try {
      raw = await readJson(c.req.raw);
    } catch {
      return c.json({ error: 'Corps JSON invalide' }, 400);
    }
    const parsed = entry.schema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      return c.json({ ok: true, result: await entry.run(parsed.data) });
    } catch (err) {
      if (err instanceof DegradedError) return c.json({ error: err.message }, 503);
      if (err instanceof InvalidInputError) return c.json({ error: err.message }, 400);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return r;
}
