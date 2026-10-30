import type { DatabaseSync } from 'node:sqlite';
import type { Action, ActionRegistry } from '../contract/actions.ts';
import { recordCost } from '../contract/costs.ts';
import { keyRefused, keyWorks } from '../llm/keys.ts';
import { costOf, priceOf, spentToday } from '../llm/models.ts';
import {
  ProviderError,
  type ChatMessage,
  type LlmProvider,
  type ProviderId,
  type ToolCall,
} from '../llm/types.ts';
import { markPina } from '../triage/journal.ts';
import { listLabels } from '../triage/labels.ts';
import type { ScreenContext } from '../types.ts';
import { beforeOf, inverseOf } from './inverse.ts';
import { systemPrompt, toolName } from './prompt.ts';
import {
  addCard,
  appendMessage,
  cardsOf,
  dayOf,
  expireOld,
  getCard,
  messagesOf,
  pendingInTurn,
  pinaSettings,
  putInverseBack,
  setCardInput,
  setCardStatus,
  takeInverse,
  type Card,
} from './store.ts';

export type { ScreenContext } from '../types.ts';

export interface PinaDeps {
  db: DatabaseSync;
  actions: ActionRegistry;
  provider: () => { provider: LlmProvider; model: string } | undefined;
  clock: () => Date;
  /** The provider the triage uses: a key it shares with Pina pauses the triage when refused. */
  triageProvider?: () => ProviderId | undefined;
}

const MAX_ROUNDS = 8;
const MAX_TOKENS = 4096;

export const NO_PROVIDER = 'Aucun modèle choisi pour l’agent : à régler dans Réglages › Fournisseurs d’IA.';
const CAP =
  'J’ai atteint mon plafond de dépense pour aujourd’hui : on reprend demain, ou tu peux le relever dans Réglages › Agent.';
const TOO_LONG =
  'Je m’arrête là, ça me demandait trop d’allers-retours. Dis-moi par où reprendre, ou découpe la demande.';
const EMPTY = 'Je n’ai rien de clair à te répondre là-dessus. Tu peux reformuler ?';
const FAILED: Record<ProviderError['kind'], string> = {
  key: 'Le fournisseur d’IA refuse ma clé : à vérifier dans Réglages › Fournisseurs d’IA.',
  credit:
    'Plus de crédit chez le fournisseur d’IA : à recharger, ou choisis un autre modèle dans Réglages › Agent.',
  unavailable: 'Le fournisseur d’IA ne répond pas pour le moment. Réessaie dans un instant.',
  format: 'Le fournisseur d’IA m’a renvoyé une réponse illisible. Réessaie dans un instant.',
};
const REFUSED =
  'CrOliX a refusé cette action : elle n’a pas été faite. Ne la refais pas sans qu’il le demande.';
const ALREADY_UNDONE = 'Action déjà annulée';
const EXPIRED = 'Cette action a expiré sans être validée : elle n’a pas été faite.';
const WAITING = 'En attente de la validation de CrOliX : pas encore faite.';
const LATE = 'Décisions de CrOliX sur tes actions en attente, prises depuis :';

/** The tools sent to the model, and the action behind each tool name. */
export function toolsOf(actions: Action[]) {
  const byTool = new Map<string, Action>();
  for (const a of actions) {
    // The mapping must stay reversible: a catalog name with `_` could meet another one.
    if (a.name.includes('_')) throw new Error(`Nom d’action avec « _ » : ${a.name}`);
    if (byTool.has(toolName(a.name))) throw new Error(`Nom d’outil en double : ${toolName(a.name)}`);
    byTool.set(toolName(a.name), a);
  }
  const specs = actions.map((a) => ({ name: toolName(a.name), description: a.description, input: a.input }));
  return { byTool, specs };
}

type Outcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Runs one catalog action as the contract route does, but every failure is an answer. */
async function runAction(actions: ActionRegistry, name: string, input: unknown): Promise<Outcome> {
  const entry = actions.get(name);
  if (!entry) return { ok: false, error: `Action inconnue : ${name}` };
  const parsed = entry.schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  try {
    return { ok: true, result: await entry.run(parsed.data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Cards are decided through runCard, refuseCard and expireCards only (Task 10 too), never setCardStatus.
const running = new Set<number>();

/**
 * Runs a pending card's action (validated by CrOliX, or at once in `immediate` mode) and settles it:
 * `done` with its inverse, or `failed`. `undefined` when the card is not pending or already running,
 * so that it never runs twice; while it runs, nothing else can decide it.
 */
export async function runCard(deps: Pick<PinaDeps, 'db' | 'actions' | 'clock'>, cardId: number) {
  const card = getCard(deps.db, cardId);
  if (!card || card.status !== 'pending' || running.has(cardId)) return undefined;
  running.add(cardId);
  try {
    const before = beforeOf(deps.db, card.action, card.input);
    const out = await runAction(deps.actions, card.action, card.input);
    const at = deps.clock();
    const journalId =
      out.ok && isObject(out.result) ? (out.result as { journalId?: unknown }).journalId : undefined;
    if (typeof journalId === 'number') markPina(deps.db, journalId);
    const settled = out.ok
      ? setCardStatus(deps.db, cardId, 'pending', 'done', {
          result: out.result,
          inverse: inverseOf(card.action, card.input, out.result, before) ?? undefined,
          at,
        })
      : setCardStatus(deps.db, cardId, 'pending', 'failed', { error: out.error, at });
    // Impossible while every decision goes through this file: said loudly if it ever happens.
    if (!settled) console.error(`Pina : carte ${cardId} décidée pendant son exécution`, JSON.stringify(out));
  } finally {
    running.delete(cardId);
  }
  return getCard(deps.db, cardId);
}

/** CrOliX refuses a card: `false` when it is no longer pending or its action is running. */
export function refuseCard(deps: Pick<PinaDeps, 'db' | 'clock'>, cardId: number): boolean {
  if (running.has(cardId)) return false;
  return setCardStatus(deps.db, cardId, 'pending', 'refused', { at: deps.clock() });
}

/** « Modifier »: replaces a pending card's input, validated by the action's schema. */
export function editCard(
  deps: Pick<PinaDeps, 'db' | 'actions'>,
  cardId: number,
  input: unknown,
): { ok: true } | { ok: false; error: string; status: 400 | 409 } {
  const card = getCard(deps.db, cardId);
  if (!card || card.status !== 'pending' || running.has(cardId))
    return { ok: false, error: 'Carte déjà décidée', status: 409 };
  const parsed = deps.actions.get(card.action)?.schema.safeParse(input);
  if (!parsed?.success)
    return { ok: false, error: parsed ? parsed.error.message : 'Action inconnue', status: 400 };
  return setCardInput(deps.db, cardId, parsed.data)
    ? { ok: true }
    : { ok: false, error: 'Carte déjà décidée', status: 409 };
}

/** « Annuler »: runs a done card's inverse, once. `undefined` when there is none (or already taken). */
export async function undoCard(deps: Pick<PinaDeps, 'db' | 'actions'>, cardId: number) {
  const inverse = takeInverse(deps.db, cardId);
  if (!inverse) return undefined;
  const out = await runAction(deps.actions, inverse.action, inverse.input);
  // A journal line already undone stays final: the inverse is not given back.
  if (!out.ok && out.error !== ALREADY_UNDONE) putInverseBack(deps.db, cardId, inverse);
  return out;
}

/**
 * CrOliX decides a card, from the app or through the contract: expiry, « Modifier », the run, then
 * the model's loop goes on with the outcome. A deletion takes no input: it is accepted as proposed.
 */
export async function decideCard(
  deps: PinaDeps,
  id: number,
  decision: 'accept' | 'refuse',
  input?: unknown,
): Promise<{ ok: true; card: Card } | { ok: false; status: 400 | 404 | 409; error: string }> {
  const card = getCard(deps.db, id);
  if (!card) return { ok: false, status: 404, error: 'Carte inconnue' };
  const today = dayOf(deps.clock());
  // Yesterday's card is expired even if the daily tidy has not run: nothing runs for it.
  if (card.day !== today) {
    if (card.status !== 'pending' && card.status !== 'expired')
      return { ok: false, status: 409, error: 'Carte déjà décidée' };
    expireCards(deps.db, today);
    return { ok: false, status: 409, error: 'Carte expirée' };
  }
  if (decision === 'accept' && input !== undefined) {
    if (card.effect === 'delete')
      return { ok: false, status: 400, error: 'Une suppression ne se modifie pas' };
    const edited = editCard(deps, id, input);
    if (!edited.ok) return edited;
  }
  const decided =
    decision === 'accept' ? await runCard(deps, id) : refuseCard(deps, id) ? getCard(deps.db, id) : undefined;
  if (!decided) return { ok: false, status: 409, error: 'Carte déjà décidée' };
  // After the decision, never inside the queue: the loop goes on with its outcome.
  await resume(deps, id);
  return { ok: true, card: getCard(deps.db, id)! };
}

/** The daily tidy: earlier days' pending cards expire, except one being run right now. */
export function expireCards(db: DatabaseSync, today: string): void {
  expireOld(db, today, [...running]);
}

/** A stored message knows its turn (a request is its own turn); the providers never see it. */
type Stored = ChatMessage & { turn?: number };

const toolResult = (turn: number, callId: string, out: Outcome): Stored =>
  out.ok
    ? { role: 'tool', callId, content: JSON.stringify(out.result ?? null), isError: false, turn }
    : { role: 'tool', callId, content: out.error, isError: true, turn };

function cardResult(c: Card): Stored {
  if (c.status === 'done') {
    // The model must describe what really ran, not what it had asked.
    const result = c.edited ? { result: c.result, modifiéParCrOliX: true, entréeFinale: c.input } : c.result;
    return toolResult(c.turn, c.callId, { ok: true, result });
  }
  if (c.status === 'refused')
    return { role: 'tool', callId: c.callId, content: REFUSED, isError: false, turn: c.turn };
  const error = c.status === 'failed' ? (c.error ?? 'Échec') : EXPIRED;
  return toolResult(c.turn, c.callId, { ok: false, error });
}

/**
 * The day's thread as the provider takes it. Each call is answered exactly once, right after its
 * assistant message: by its result, or « en attente » when CrOliX spoke again before deciding. A
 * decision taken after that comes later as a user note, so that the thread ends on what is new.
 * Results are matched by turn and call id: some servers reuse call ids.
 */
function history(db: DatabaseSync, day: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const names = new Map<string, string>();
  let open = new Map<string, string>(); // `turn:callId` → callId, for the last assistant message
  let note: { role: 'user'; text: string } | undefined;
  const close = () => {
    for (const callId of open.values()) out.push({ role: 'tool', callId, content: WAITING, isError: false });
    open = new Map();
  };
  for (const { message } of messagesOf(db, day)) {
    const m = message as Stored;
    if (m.role === 'tool') {
      const key = `${m.turn}:${m.callId}`;
      if (open.delete(key)) {
        out.push({ role: 'tool', callId: m.callId, content: m.content, isError: m.isError });
        continue;
      }
      const line = `- ${names.get(key) ?? 'action'} (${m.callId})${m.isError ? ', erreur' : ''} : ${m.content}`;
      if (note) note.text += `\n${line}`;
      else {
        close();
        out.push((note = { role: 'user', text: `${LATE}\n${line}` }));
      }
      continue;
    }
    close();
    note = undefined;
    if (m.role === 'user') out.push({ role: 'user', text: m.text });
    else {
      const reply: ChatMessage = { role: 'assistant', text: m.text, toolCalls: m.toolCalls };
      if (m.replay !== undefined) reply.replay = m.replay;
      out.push(reply);
      for (const c of m.toolCalls) {
        open.set(`${m.turn}:${c.id}`, c.id);
        names.set(`${m.turn}:${c.id}`, c.name);
      }
    }
  }
  close();
  return out;
}

const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One loop per day at a time, so that a resume and a request never interleave their messages. */
const chains = new Map<string, Promise<void>>();
function serial(day: string, run: () => Promise<void>): Promise<void> {
  const next = (chains.get(day) ?? Promise.resolve()).catch(() => undefined).then(run);
  chains.set(day, next);
  const forget = () => {
    if (chains.get(day) === next) chains.delete(day);
  };
  next.then(forget, forget);
  return next;
}

/**
 * One CrOliX request: the turn runs until an answer, a card to decide, or a bound. `mode: 'validate'`
 * (a delegation from the core) forces cards over Pina's own setting. Gives the turn's id.
 */
export async function ask(
  deps: PinaDeps,
  text: string,
  context: ScreenContext,
  opts: { mode?: 'validate' } = {},
): Promise<number> {
  const day = dayOf(deps.clock());
  let turn = 0;
  await serial(day, async () => {
    // The context and the mode ride with the request, so that a resumed turn sees the same ones.
    const request = { role: 'user' as const, text, context, ...(opts.mode ? { mode: opts.mode } : {}) };
    turn = appendMessage(deps.db, day, request, deps.clock());
    await loop(deps, day, turn, context, opts.mode);
  });
  return turn;
}

/** After a decision: once no card of the turn is pending, their outcomes go to the model and it goes on. */
export async function resume(deps: PinaDeps, cardId: number): Promise<void> {
  const card = getCard(deps.db, cardId);
  if (!card) return;
  await serial(card.day, async () => {
    if (pendingInTurn(deps.db, card.turn) > 0) return;
    const thread = messagesOf(deps.db, card.day);
    const answered = new Set(
      thread.flatMap(({ message: m }) =>
        m.role === 'tool' && (m as Stored).turn === card.turn ? [m.callId] : [],
      ),
    );
    const open = cardsOf(deps.db, card.day).filter((c) => c.turn === card.turn && !answered.has(c.callId));
    // Already resumed (a second click): nothing left to say.
    if (!open.length) return;
    for (const c of open) appendMessage(deps.db, card.day, cardResult(c), deps.clock());
    const request = thread.find((m) => m.id === card.turn)?.message as
      { context?: ScreenContext; mode?: 'validate' } | undefined;
    await loop(deps, card.day, card.turn, request?.context ?? { screen: 'mail' }, request?.mode);
  });
}

async function loop(
  deps: PinaDeps,
  day: string,
  turn: number,
  context: ScreenContext,
  forced?: 'validate',
): Promise<void> {
  const { db } = deps;
  const store = (m: Stored) => {
    const stored: Stored = { ...m, turn };
    appendMessage(db, day, stored, deps.clock());
  };
  const say = (text: string) => {
    store({ role: 'assistant', text, toolCalls: [] });
  };
  const choice = deps.provider();
  if (!choice) return say(NO_PROVIDER);
  const { provider, model } = choice;
  const settings = pinaSettings(db);
  const { byTool, specs: tools } = toolsOf(deps.actions.list());
  const system = systemPrompt({
    now: deps.clock(),
    context,
    instructions: settings.instructions,
    labels: listLabels(db),
    identity: settings,
  });
  // A resumed turn keeps the rounds it already used, and only its own.
  let rounds = messagesOf(db, day).filter(
    ({ message: m }) => m.role === 'assistant' && (m as Stored).turn === turn,
  ).length;

  for (;;) {
    if (rounds >= MAX_ROUNDS) return say(TOO_LONG);
    if (spentToday(db, 'pina', deps.clock()) >= settings.dailyCapUsd) return say(CAP);
    let res;
    try {
      res = await provider.chat({ model, system, messages: history(db, day), tools, maxTokens: MAX_TOKENS });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === 'key')
        keyRefused(db, provider.id, deps.clock(), deps.triageProvider?.() === provider.id);
      return say(FAILED[err.kind]);
    }
    rounds += 1;
    keyWorks(db, provider.id, deps.clock());
    const price = priceOf(db, provider.id, model);
    // shortcut: an unknown price counts 0 without the triage's « prix inconnu » event; add it if Pina's model has none.
    recordCost(
      db,
      { provider: provider.id, model, amount: price ? costOf(price, res.usage) : 0, calls: 1 },
      deps.clock(),
      'pina',
    );

    if (!res.toolCalls.length) return say(res.text.trim() ? res.text : EMPTY);
    const reply: ChatMessage = { role: 'assistant', text: res.text, toolCalls: res.toolCalls };
    if (res.replay !== undefined) reply.replay = res.replay;
    store(reply);

    let waiting = 0;
    for (const call of res.toolCalls) {
      const out = await handle(call);
      if (out === 'card') waiting += 1;
      else store(toolResult(turn, call.id, out));
    }
    if (waiting) return;
  }

  /** A read runs; a write or a deletion becomes a card, run at once only for a write in `immediate` mode. */
  async function handle(call: ToolCall): Promise<Outcome | 'card'> {
    const action = byTool.get(call.name);
    if (!action) return { ok: false, error: `Action inconnue : ${call.name}` };
    if (call.invalidArguments !== undefined || !isObject(call.input))
      return { ok: false, error: 'Arguments illisibles : un objet JSON est attendu.' };
    const parsed = deps.actions.get(action.name)!.schema.safeParse(call.input);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    if (action.effect === 'read') return runAction(deps.actions, action.name, call.input);
    const id = addCard(db, {
      day,
      turn,
      callId: call.id,
      action: action.name,
      input: call.input,
      effect: action.effect,
      now: deps.clock(),
    });
    if (action.effect === 'delete' || (forced ?? settings.mode) === 'validate') return 'card';
    const card = await runCard(deps, id);
    if (card?.status === 'done') return { ok: true, result: card.result };
    return { ok: false, error: card?.error ?? 'Action non faite' };
  }
}
