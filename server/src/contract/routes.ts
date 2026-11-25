import { Hono } from 'hono';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import type { AppDeps } from '../app.ts';
import { CONTRACT, SATELLITE } from '../identity.ts';
import { DegradedError, InvalidInputError } from './actions.ts';
import { pair, recordPairingFailure, requireToken } from './auth.ts';
import { authorizationPage, exchangeAuthorizationCode, readAuthorizationRequest } from './authorize.ts';
import { costsSince } from './costs.ts';
import { ask, decideCard, expireCards, type PinaDeps } from '../pina/agent.ts';
import { cardText } from '../pina/lines.ts';
import { Context, Decision } from '../pina/routes.ts';
import { cardsOf, dayOf, declaredAgentName, getCard, messagesOf, type Card } from '../pina/store.ts';
import { spentToday } from '../llm/models.ts';
import type { ScreenContext } from '../types.ts';
import type { CardField, ContractCard, PinaCardStatus } from '../types.ts';
import { getStoredMessage, viewFilter } from '../gmail/store.ts';
import { listBoxes, listTags } from '../triage/labels.ts';
import { mask } from '../triage/mask.ts';
import { getProposal, isBulk, type Proposal } from '../triage/proposals.ts';
import { BadRequestError, NotFoundError, type ActionDeps } from '../gmail/actions.ts';
import type { GoogleClient } from '../google/client.ts';
import { ConflictError } from '../triage/journal.ts';
import { correct, refuse, validate } from '../triage/pipeline.ts';
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
// « Modifier »'s input, with the size bound the app's route has, or the corrected fields; an unknown key is a 400.
const Accept = Decision.pick({ input: true })
  .extend({ values: z.record(z.string(), z.array(z.string())).optional(), answer: z.unknown().optional() })
  .strict();
// The core's context is Pina's own, every key optional; an unknown key is a mistake, not noise.
const Delegation = z.object({
  request: z.string().min(1).max(4000),
  context: Context.partial().strict().optional(),
});
const PauseBody = z.object({ reason: z.string().max(500).optional(), by: z.literal('core').optional() });
const ResumeBody = z.object({ by: z.literal('core').optional() });
export const PAUSED = 'Acedia est en pause : rien ne se fait tant qu’elle n’est pas reprise.';

function toContractCard(db: AppDeps['db'], card: Card): ContractCard {
  const text = cardText(db, card);
  const mailId = (card.input as { id?: unknown } | null)?.id;
  // A card from a mail may quote it, never its secrets.
  const fromMail = /^(mail|draft)./.test(card.action) ? mask : (s: string) => s;
  return {
    id: String(card.id),
    action: card.action,
    effect: card.effect === 'delete' ? 'delete' : 'write',
    kind: text.title,
    ...(card.action === 'draft.create' && (card.input as { replyTo?: unknown } | null)?.replyTo
      ? { sends: true as const }
      : {}),
    title: fromMail(text.title),
    lines: text.fields.map((f) => fromMail(`${f.label} : ${f.value}`)),
    status: card.status,
    at: card.createdAt,
    ...(card.error ? { error: card.error } : {}),
    ...(card.action.startsWith('mail.') && mailId !== undefined ? { link: mailLink(mailId) } : {}),
  };
}

const TARGETS = [
  { value: 'trash', label: 'Corbeille' },
  { value: 'spam', label: 'Spam' },
];

/** A waiting proposal of the triage as a card: `mail:<id>`, its synthesis in `lines`, everything masked. */
function proposalCard(
  db: AppDeps['db'],
  p: Proposal,
  status: ContractCard['status'] = 'pending',
): ContractCard {
  const fields: CardField[] = [];
  if (p.boxId)
    fields.push({
      name: 'box',
      label: 'Boîte',
      value: [p.boxId],
      choices: [...listBoxes(db).map((b) => ({ value: b.id, label: b.name })), ...TARGETS],
    });
  fields.push({
    name: 'tags',
    label: 'Étiquettes',
    value: p.tagIds,
    choices: listTags(db).map((t) => ({ value: t.id, label: t.name })),
    multiple: true,
  });
  // A reason from before the synthesis never went through the copy filter: it stays home.
  const reason = p.synthesis && p.reason ? mask(p.reason) : '';
  return {
    id: `mail:${p.messageId}`,
    action: 'mail.validate',
    effect: 'write',
    kind: 'Proposition de tri',
    title: mask(getStoredMessage(db, p.messageId)?.subject ?? ''),
    lines: (p.synthesis ?? []).map(mask),
    ...(reason ? { reason } : {}),
    importance: p.importance === 'urgent' ? 'normal' : 'low',
    ...(isBulk(db, p) ? { bulk: true as const } : {}),
    fields,
    status,
    at: p.createdAt,
    link: mailLink(p.messageId),
  };
}

/** The proposals « À valider » shows (or the one of `id`): waiting, and the mail still in the inbox. */
function waitingProposals(db: AppDeps['db'], id?: string): Proposal[] {
  const only = id === undefined ? '' : ' AND id = ?';
  const rows = db
    .prepare(`SELECT id FROM messages WHERE ${viewFilter('pending')!.where}${only}`)
    .all(...(id === undefined ? [] : [id])) as { id: string }[];
  return rows.flatMap((r) => getProposal(db, r.id) ?? []);
}

/** What `accept { values }` asks of a proposal's fields, or the contract's 400. */
function readValues(card: ContractCard, values: Record<string, string[]>): Record<string, string[]> {
  for (const [name, chosen] of Object.entries(values)) {
    const field = card.fields?.find((f) => f.name === name);
    if (!field) throw new BadRequestError(`Champ inconnu : ${name}`);
    const out = chosen.find((v) => !field.choices.some((c) => c.value === v));
    if (out !== undefined) throw new BadRequestError(`« ${out} » n’est pas un choix de ${field.label}`);
    if (!field.multiple && chosen.length !== 1) throw new BadRequestError(`${field.label} : un seul choix`);
  }
  return values;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function contractRoutes(deps: AppDeps, pina: PinaDeps, google?: GoogleClient): Hono {
  const { db, clock, actions } = deps;
  const mail = (): ActionDeps => {
    if (!google) throw new BadRequestError('Google n’est pas configuré sur ce serveur');
    return { db, google, now: clock };
  };

  /** The gesture on a proposal card: the card must still be served by `/cards` before anything reaches Gmail. */
  const decideProposal = async (
    id: string,
    decision: 'accept' | 'refuse',
    values?: Record<string, string[]>,
  ): Promise<{ card: ContractCard } | { error: string; status: 400 | 404 | 409 }> => {
    try {
      if (!getProposal(db, id)) throw new NotFoundError('Carte inconnue');
      const served = waitingProposals(db, id)[0];
      if (!served) throw new ConflictError('Cette carte n’est plus en attente');
      if (decision === 'refuse') await refuse(mail(), id);
      else {
        const asked = values ? readValues(proposalCard(db, served), values) : {};
        const boxId = asked.box?.[0] ?? served.boxId;
        const tagIds = asked.tags ?? served.tagIds;
        if (boxId === served.boxId && sameSet(tagIds, served.tagIds)) await validate(mail(), id);
        else await correct(mail(), id, boxId, tagIds);
      }
      const status = decision === 'refuse' ? 'refused' : 'done';
      return { card: proposalCard(db, getProposal(db, id)!, status) };
    } catch (err) {
      if (err instanceof NotFoundError) return { error: err.message, status: 404 };
      if (err instanceof BadRequestError) return { error: err.message, status: 400 };
      if (err instanceof ConflictError) return { error: err.message, status: 409 };
      throw err;
    }
  };
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
    const name = declaredAgentName(db);
    return c.json({
      ...status,
      ...paused,
      ...(state.pausedBy && { pausedBy: state.pausedBy }),
      version: deps.version,
      contract: CONTRACT,
      agent: true,
      ...(name && { agentName: name }),
    });
  });

  r.get('/costs', (c) => {
    const raw = c.req.query('since');
    const since = raw ? new Date(raw) : new Date(0);
    if (Number.isNaN(since.getTime())) return c.json({ error: `Date illisible : ${raw}` }, 400);
    return c.json(costsSince(db, since, clock()));
  });

  const parseBody = async (req: Request, schema: typeof PauseBody | typeof ResumeBody) => {
    try {
      return schema.safeParse(await readJson(req));
    } catch {
      return undefined;
    }
  };

  r.post('/pause', async (c) => {
    const body = await parseBody(c.req.raw, PauseBody);
    if (!body?.success) return c.json({ error: 'Corps invalide' }, 400);
    const by = body.data.by ?? 'local';
    if (getState(db)[by]) return c.json({ error: 'Déjà en pause' }, 409);
    setPaused(db, true, by);
    return c.json({ status: 'paused' });
  });

  r.post('/resume', async (c) => {
    const body = await parseBody(c.req.raw, ResumeBody);
    if (!body?.success) return c.json({ error: 'Corps invalide' }, 400);
    const by = body.data.by ?? 'local';
    if (!getState(db)[by]) return c.json({ error: 'Déjà actif' }, 409);
    setPaused(db, false, by);
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
    // shortcut: a settled proposal has no decision time in `proposals`, so status=done or refused serves the agent
    // only; add a decided_at column when the core asks for them.
    if (status !== 'pending') return c.json({ cards });
    const all = [...cards, ...waitingProposals(db).map((p) => proposalCard(db, p))];
    return c.json({ cards: all.sort((a, b) => b.at.localeCompare(a.at)) });
  });

  // The card is decided once `decideCard` answers: a failure of the loop that resumes (the model's
  // turn) is logged, never turned into an error for a card that is already settled.
  const decide = async (id: string, decision: 'accept' | 'refuse', input?: unknown) => {
    try {
      return await decideCard(pina, Number(id), decision, input);
    } catch (err) {
      log(
        `Agent : reprise après la carte ${id} en échec : ${err instanceof Error ? err.message : String(err)}`,
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
    const { input, values, answer } = parsed.data;
    // No card of Acedia has `options`: an answer is never taken.
    if (answer !== undefined) return c.json({ error: 'Cette carte n’attend pas de réponse' }, 400);
    const id = c.req.param('id');
    if (id.startsWith('mail:')) {
      if (input !== undefined) return c.json({ error: 'Une proposition se corrige par values' }, 400);
      const out = await decideProposal(id.slice(5), 'accept', values);
      return 'card' in out ? c.json(out) : c.json({ error: out.error }, out.status);
    }
    if (values !== undefined) return c.json({ error: 'Cette carte n’a pas de champs à corriger' }, 400);
    const out = await decide(id, 'accept', input);
    if (!out.ok) return c.json({ error: out.error }, out.status);
    return c.json({ card: toContractCard(db, out.card) });
  });

  r.post('/cards/:id/refuse', async (c) => {
    const id = c.req.param('id');
    if (id.startsWith('mail:')) {
      const out = await decideProposal(id.slice(5), 'refuse');
      return 'card' in out ? c.json(out) : c.json({ error: out.error }, out.status);
    }
    const out = await decide(id, 'refuse');
    if (!out.ok) return c.json({ error: out.error }, out.status);
    return c.json({ card: toContractCard(db, out.card) });
  });

  r.post('/agent', async (c) => {
    const parsed = Delegation.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const cost = (amount: number) => ({ currency: 'USD' as const, amount });
    // shortcut: refs empty until the core shows them, fill from the turn's read tools
    const refs: never[] = [];
    if (getState(db).pausedBy === 'local') return c.json({ summary: PAUSED, cards: [], refs, cost: cost(0) });
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
