import type { DatabaseSync } from 'node:sqlite';
import type { ActionRegistry } from '../contract/actions.ts';
import { recordCost } from '../contract/costs.ts';
import { keyRefused, keyWorks } from '../llm/keys.ts';
import { costOf, priceOf, spentToday } from '../llm/models.ts';
import { ProviderError, type ChatMessage, type LlmProvider, type ToolCall } from '../llm/types.ts';
import { listLabels } from '../triage/labels.ts';
import { beforeOf, inverseOf } from './inverse.ts';
import { systemPrompt } from './prompt.ts';
import {
  addCard,
  appendMessage,
  cardsOf,
  dayOf,
  getCard,
  messagesOf,
  pendingInTurn,
  pinaSettings,
  setCardStatus,
  type Card,
} from './store.ts';

export interface ScreenContext {
  screen: 'mail' | 'pending' | 'agenda' | 'tasks' | 'journal' | 'settings' | 'compose';
  mailId?: string;
  day?: string;
  listId?: string;
  draftId?: string;
}

export interface PinaDeps {
  db: DatabaseSync;
  actions: ActionRegistry;
  provider: () => { provider: LlmProvider; model: string } | undefined;
  clock: () => Date;
}

const MAX_ROUNDS = 8;
const MAX_TOKENS = 4096;

export const NO_PROVIDER = 'Aucun modèle choisi pour Pina : à régler dans Réglages › Fournisseurs d’IA.';
const CAP =
  'J’ai atteint mon plafond de dépense pour aujourd’hui : on reprend demain, ou tu peux le relever dans Réglages › Pina.';
const TOO_LONG =
  'Je m’arrête là, ça me demandait trop d’allers-retours. Dis-moi par où reprendre, ou découpe la demande.';
const EMPTY = 'Je n’ai rien de clair à te répondre là-dessus. Tu peux reformuler ?';
const FAILED: Record<ProviderError['kind'], string> = {
  key: 'Le fournisseur d’IA refuse ma clé : à vérifier dans Réglages › Fournisseurs d’IA.',
  credit:
    'Plus de crédit chez le fournisseur d’IA : à recharger, ou choisis un autre modèle dans Réglages › Pina.',
  unavailable: 'Le fournisseur d’IA ne répond pas pour le moment. Réessaie dans un instant.',
  format: 'Le fournisseur d’IA m’a renvoyé une réponse illisible. Réessaie dans un instant.',
};
const REFUSED =
  'CrOliX a refusé cette action : elle n’a pas été faite. Ne la refais pas sans qu’il le demande.';
const EXPIRED = 'Cette action a expiré sans être validée : elle n’a pas été faite.';
const WAITING = 'En attente de la validation de CrOliX : pas encore faite.';

// Tool names take only [a-zA-Z0-9_-] at both providers; no catalog name has an underscore.
const toolName = (action: string) => action.replaceAll('.', '_');

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

const running = new Set<number>();

/**
 * Runs a pending card's action (validated by CrOliX, or at once in `immediate` mode) and settles it:
 * `done` with its inverse, or `failed`. `undefined` when the card is not pending or already running,
 * so that it never runs twice.
 */
export async function runCard(deps: Pick<PinaDeps, 'db' | 'actions' | 'clock'>, cardId: number) {
  const card = getCard(deps.db, cardId);
  if (!card || card.status !== 'pending' || running.has(cardId)) return undefined;
  running.add(cardId);
  try {
    const before = beforeOf(deps.db, card.action, card.input);
    const out = await runAction(deps.actions, card.action, card.input);
    const at = deps.clock();
    if (out.ok) {
      const inverse = inverseOf(card.action, card.input, out.result, before) ?? undefined;
      setCardStatus(deps.db, cardId, 'pending', 'done', { result: out.result, inverse, at });
    } else setCardStatus(deps.db, cardId, 'pending', 'failed', { error: out.error, at });
  } finally {
    running.delete(cardId);
  }
  return getCard(deps.db, cardId);
}

const toolResult = (callId: string, out: Outcome): ChatMessage =>
  out.ok
    ? { role: 'tool', callId, content: JSON.stringify(out.result ?? null), isError: false }
    : { role: 'tool', callId, content: out.error, isError: true };

function cardResult(c: Card): ChatMessage {
  if (c.status === 'done') return toolResult(c.callId, { ok: true, result: c.result });
  if (c.status === 'refused') return { role: 'tool', callId: c.callId, content: REFUSED, isError: false };
  return toolResult(c.callId, { ok: false, error: c.status === 'failed' ? (c.error ?? 'Échec') : EXPIRED });
}

/**
 * The day's thread as the provider takes it: each tool result right after the call that asked it,
 * wherever it was stored, and a call still waiting for CrOliX answered « en attente ».
 */
function history(db: DatabaseSync, day: string): ChatMessage[] {
  const thread = messagesOf(db, day).map((m) => m.message);
  const results = new Map(thread.flatMap((m) => (m.role === 'tool' ? [[m.callId, m] as const] : [])));
  return thread.flatMap((m): ChatMessage[] => {
    if (m.role === 'tool') return [];
    if (m.role === 'user') return [{ role: 'user', text: m.text }];
    return [
      m,
      ...m.toolCalls.map(
        (c): ChatMessage =>
          results.get(c.id) ?? { role: 'tool', callId: c.id, content: WAITING, isError: false },
      ),
    ];
  });
}

const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One CrOliX request: the turn runs until an answer, a card to decide, or a bound. */
export async function ask(deps: PinaDeps, text: string, context: ScreenContext): Promise<void> {
  const day = dayOf(deps.clock());
  // The context rides with the request, so that a resumed turn sees the same screen.
  const request = { role: 'user' as const, text, context };
  const turn = appendMessage(deps.db, day, request, deps.clock());
  await loop(deps, day, turn, context);
}

/** After a decision: once no card of the turn is pending, their outcomes go to the model and it goes on. */
export async function resume(deps: PinaDeps, cardId: number): Promise<void> {
  const card = getCard(deps.db, cardId);
  if (!card || pendingInTurn(deps.db, card.turn) > 0) return;
  const thread = messagesOf(deps.db, card.day);
  const answered = new Set(thread.flatMap((m) => (m.message.role === 'tool' ? [m.message.callId] : [])));
  const open = cardsOf(deps.db, card.day).filter((c) => c.turn === card.turn && !answered.has(c.callId));
  // Already resumed (a second click): nothing left to say. Checked and written with no await between.
  if (!open.length) return;
  for (const c of open) appendMessage(deps.db, card.day, cardResult(c), deps.clock());
  const request = thread.find((m) => m.id === card.turn)?.message as { context?: ScreenContext } | undefined;
  await loop(deps, card.day, card.turn, request?.context ?? { screen: 'mail' });
}

async function loop(deps: PinaDeps, day: string, turn: number, context: ScreenContext): Promise<void> {
  const { db } = deps;
  const say = (text: string) => {
    appendMessage(db, day, { role: 'assistant', text, toolCalls: [] }, deps.clock());
  };
  const choice = deps.provider();
  if (!choice) return say(NO_PROVIDER);
  const { provider, model } = choice;
  const settings = pinaSettings(db);
  const actions = deps.actions.list();
  const byTool = new Map(actions.map((a) => [toolName(a.name), a]));
  const tools = actions.map((a) => ({ name: toolName(a.name), description: a.description, input: a.input }));
  const system = systemPrompt({
    now: deps.clock(),
    context,
    instructions: settings.instructions,
    labels: listLabels(db),
  });
  // A resumed turn keeps the rounds it already used.
  let rounds = messagesOf(db, day).filter((m) => m.id > turn && m.message.role === 'assistant').length;

  for (;;) {
    if (rounds >= MAX_ROUNDS) return say(TOO_LONG);
    if (spentToday(db, 'pina', deps.clock()) >= settings.dailyCapUsd) return say(CAP);
    let res;
    try {
      res = await provider.chat({ model, system, messages: history(db, day), tools, maxTokens: MAX_TOKENS });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      // shortcut: keyRefused's event title speaks of the triage; one shared event per key change.
      if (err.kind === 'key') keyRefused(db, provider.id, deps.clock());
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
    appendMessage(db, day, reply, deps.clock());

    let waiting = 0;
    for (const call of res.toolCalls) {
      const out = await handle(call);
      if (out === 'card') waiting += 1;
      else appendMessage(db, day, toolResult(call.id, out), deps.clock());
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
    if (action.effect === 'delete' || settings.mode === 'validate') return 'card';
    const card = await runCard(deps, id);
    if (card?.status === 'done') return { ok: true, result: card.result };
    return { ok: false, error: card?.error ?? 'Action non faite' };
  }
}
