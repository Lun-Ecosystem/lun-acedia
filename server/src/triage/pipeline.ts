import type { DatabaseSync } from 'node:sqlite';
import { recordCost } from '../contract/costs.ts';
import { emitEvent, mailLink } from '../contract/events.ts';
import { addDegraded, clearDegraded, getState } from '../contract/state.ts';
import { getSetting, putSetting } from '../db.ts';
import {
  BadRequestError,
  boxIds,
  fileMail,
  NotFoundError,
  reportSpam,
  setTags,
  trashMail,
  type ActionDeps,
  type BatchOp,
  type LabelChange,
} from '../gmail/actions.ts';
import { plainText, stripHidden } from '../gmail/body.ts';
import { getStoredMessage, header, upsertMessage, type StoredMessage } from '../gmail/store.ts';
import { fetchFull } from '../gmail/read.ts';
import { fetchMetadata } from '../gmail/sync.ts';
import { GoogleApiError, GoogleNotConnectedError, GoogleReauthError } from '../google/client.ts';
import { costOf, priceOf } from '../llm/models.ts';
import { keyRefused, keyWorks } from '../llm/keys.ts';
import { ProviderError } from '../llm/types.ts';
import {
  ClassifierError,
  CreditExhaustedError,
  KeyRefusedError,
  type Classification,
  type Classifier,
} from './classifier.ts';
import { getExample, pickExamples, recordExample } from './examples.ts';
import { ConflictError, logAuto, logUser, type Previous, type UserAction } from './journal.ts';
import { listBoxes, listTags } from './labels.ts';
import {
  claim,
  DEFAULT_BULK_THRESHOLD,
  DEFAULT_THRESHOLD,
  getProposal,
  isBulk,
  proposalView,
  triageSettings,
  release,
  saveProposal,
  setProposalStatus,
  type Proposal,
} from './proposals.ts';
import { dropCopied, mask } from './mask.ts';
import { dequeue, enqueue, failedAttempt, MAX_ATTEMPTS, queuedIds } from './queue.ts';
import { createRule, listRules, matchRule } from './rules.ts';
import type { Rule } from '../types.ts';

export { getProposal };

export interface TriageDeps extends ActionDeps {
  /** Absent without an Anthropic key (saved or in `.env`): only the rules run. */
  classifier?: Classifier | undefined;
  /** The server log; `console.log` when absent. */
  log?: ((line: string) => void) | undefined;
}

/** A mail never goes to spam on a lower confidence, whatever the threshold. */
export const SPAM_CONFIDENCE = 95;

export { DEFAULT_BULK_THRESHOLD, DEFAULT_THRESHOLD };

export const getThreshold = (db: DatabaseSync) => triageSettings(db).threshold;

const isUrgentName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase() === 'urgent';

function tagIdsOf(db: DatabaseSync, labels: string[]): string[] {
  const tags = new Set(listTags(db).map((t) => t.id));
  return labels.filter((l) => tags.has(l));
}

/**
 * Puts a mail where a proposal says (a box, the trash, spam, or nowhere) and adds its tags; with
 * `exactTags`, the other tags are removed. One change is returned, for the journal.
 */
async function applyTarget(
  deps: ActionDeps,
  id: string,
  boxId: string | null,
  tagIds: string[],
  exactTags = false,
): Promise<LabelChange | undefined> {
  const moved =
    boxId === 'trash'
      ? await trashMail(deps, id)
      : boxId === 'spam'
        ? await reportSpam(deps, id)
        : boxId
          ? await fileMail(deps, id, boxId)
          : undefined;
  const labels = moved?.after ?? getStoredMessage(deps.db, id)?.labels ?? [];
  const add = tagIds.filter((t) => !labels.includes(t));
  const remove = exactTags ? tagIdsOf(deps.db, labels).filter((t) => !tagIds.includes(t)) : [];
  const tagged = add.length || remove.length ? await setTags(deps, id, add, remove) : undefined;
  if (!moved) return tagged;
  return tagged ? { id, before: moved.before, after: tagged.after } : moved;
}

const actionOf = (boxId: string | null) => (boxId === 'trash' || boxId === 'spam' ? boxId : 'file');

export function creditExhausted(deps: ActionDeps): void {
  if (getState(deps.db).degraded.includes('credit')) return;
  addDegraded(deps.db, 'credit');
  emitEvent(
    deps.db,
    {
      type: 'credit.exhausted',
      importance: 'normal',
      title: 'Crédit IA épuisé : le tri par l’IA est en pause, les règles continuent',
    },
    deps.now(),
  );
}

/** One `log` event per model: it is counted at 0 rather than blocking the triage. */
function warnUnknownPrice(deps: TriageDeps, key: string, model: string): void {
  const warned = getSetting<string[]>(deps.db, 'llm.unknownPriceWarned', []);
  if (warned.includes(key)) return;
  putSetting(deps.db, 'llm.unknownPriceWarned', [...warned, key]);
  emitEvent(
    deps.db,
    { type: 'llm.unknown-price', importance: 'log', title: `Prix inconnu pour ${model} : coût compté à 0` },
    deps.now(),
  );
}

async function classify(
  deps: TriageDeps & { classifier: Classifier },
  mail: StoredMessage,
): Promise<Classification | 'ai-off' | 'gone' | 'unusable'> {
  const provider = deps.classifier.provider ?? 'anthropic';
  const payload = (await fetchFull(deps.google, mail.id))?.payload;
  if (!payload) return 'gone';
  // The text the model reads, and the one its answer is compared to (`dropCopied`).
  const text = stripHidden(plainText(payload));
  try {
    const result = await deps.classifier.classify({
      mail: {
        from: header({ payload }, 'From'),
        to: header({ payload }, 'To'),
        subject: mail.subject,
        date: mail.date,
        text,
      },
      boxes: listBoxes(deps.db),
      tags: listTags(deps.db),
      examples: pickExamples(deps.db, mail),
    });
    if (getState(deps.db).degraded.includes('credit')) clearDegraded(deps.db, 'credit');
    keyWorks(deps.db, provider, deps.now());
    const model = deps.classifier.model;
    const price = priceOf(deps.db, provider, model);
    if (!price) warnUnknownPrice(deps, `${provider}/${model}`, model);
    recordCost(
      deps.db,
      { provider, model, amount: price ? costOf(price, result.usage) : 0, calls: 1 },
      deps.now(),
      'triage',
    );
    // What the AI wrote leaves the post: no copy of the body, then no secret; the clear text is never kept.
    return {
      ...result,
      reason: dropCopied([result.reason], text).map(mask).join(''),
      synthesis: dropCopied(result.synthesis, text).map(mask),
    };
  } catch (err) {
    if (err instanceof CreditExhaustedError) {
      creditExhausted(deps);
      return 'ai-off';
    }
    if (err instanceof KeyRefusedError) {
      keyRefused(deps.db, provider, deps.now());
      return 'ai-off';
    }
    if (err instanceof ClassifierError) return 'unusable';
    throw err;
  }
}

/**
 * What became of a queued mail: `done` (decided, or nothing left to decide), `wait` (the AI is out of
 * credit or its key is refused: try again later), `unusable` (the AI answered nothing usable).
 */
type Outcome = 'done' | 'wait' | 'unusable';

/** What one pass of the triage keeps from mail to mail. */
interface Pass {
  useAi: boolean;
  /** The rules already said to be skipped in this pass. */
  skipped: Set<number>;
  log: (line: string) => void;
}

/** The first rule that matches and still leads to a box: one whose box was removed since is skipped, and said so. */
function ruleFor(db: DatabaseSync, mail: StoredMessage, pass: Pass): Rule | null {
  const boxes = boxIds(db);
  let rules = listRules(db);
  for (let rule = matchRule(rules, mail); rule; rule = matchRule(rules, mail)) {
    if (boxes.includes(rule.boxId)) return rule;
    if (!pass.skipped.has(rule.id)) {
      pass.skipped.add(rule.id);
      pass.log(`Tri : règle ${rule.id} sautée, « ${rule.boxId} » n’est plus une boîte`);
    }
    const stale = rule;
    rules = rules.filter((r) => r !== stale);
  }
  return null;
}

/** Triages one claimed mail; `ai-off` when the AI just ran out of credit or refused the key. */
async function triageOne(deps: TriageDeps, id: string, pass: Pass): Promise<Outcome | 'ai-off' | 'pending'> {
  const mail = getStoredMessage(deps.db, id);
  // A mail already out of the inbox (a Gmail filter, a gesture) is left where it is.
  if (!mail?.labels.includes('INBOX')) {
    release(deps.db, id);
    return 'done';
  }

  const rule = ruleFor(deps.db, mail, pass);
  if (rule) {
    const change = await applyTarget(deps, id, rule.boxId, rule.tagIds);
    if (change) logAuto(deps.db, change, 'rule', 'file', deps.now());
    saveProposal(deps.db, {
      messageId: id,
      boxId: rule.boxId,
      tagIds: rule.tagIds,
      importance: 'none',
      confidence: 100,
      source: 'rule',
      status: 'auto',
    });
    // The rule's own urgent tag is the only way a mail gets `urgent`; the AI never does.
    const ruleUrgent = listTags(deps.db).some((t) => rule.tagIds.includes(t.id) && isUrgentName(t.name));
    emitEvent(
      deps.db,
      {
        type: 'mail.triaged',
        importance: ruleUrgent ? 'urgent' : 'info',
        title: mail.subject,
        ...(ruleUrgent
          ? {
              lines: [`De : ${mail.from.name ? `${mail.from.name} <${mail.from.addr}>` : mail.from.addr}`],
            }
          : {}),
        data: { id, boxId: rule.boxId },
        link: mailLink(id),
      },
      deps.now(),
    );
    return 'done';
  }

  // Without an AI configured, what no rule catches is filed by hand.
  const classifier = deps.classifier;
  if (!classifier) {
    release(deps.db, id);
    return 'done';
  }
  if (!pass.useAi) {
    release(deps.db, id);
    return 'wait';
  }
  const c = await classify({ ...deps, classifier }, mail);
  if (typeof c === 'string') {
    release(deps.db, id);
    return c === 'gone' ? 'done' : c;
  }

  const urgent = c.importance === 'urgent' ? listTags(deps.db).find((t) => isUrgentName(t.name)) : undefined;
  const tagIds = urgent && !c.tagIds.includes(urgent.id) ? [...c.tagIds, urgent.id] : c.tagIds;
  // At 100 (the default) everything waits for validation, whatever the AI's confidence.
  const threshold = getThreshold(deps.db);
  const auto =
    c.boxId !== null &&
    threshold < 100 &&
    c.confidence >= threshold &&
    (c.boxId !== 'spam' || c.confidence >= SPAM_CONFIDENCE);
  if (auto) {
    const change = await applyTarget(deps, id, c.boxId, tagIds);
    if (change) logAuto(deps.db, change, 'ai', actionOf(c.boxId), deps.now());
  }
  saveProposal(deps.db, {
    messageId: id,
    boxId: c.boxId,
    tagIds,
    importance: c.importance,
    confidence: c.confidence,
    reason: c.reason,
    synthesis: c.synthesis,
    source: 'ai',
    status: auto ? 'auto' : 'pending',
  });
  // A waiting proposal is served as a card; the pass signals it once, at its end (`triageNew`).
  if (!auto) return 'pending';
  if (c.importance !== 'none') {
    emitEvent(
      deps.db,
      {
        type: 'mail.triaged',
        importance: c.importance === 'urgent' ? 'normal' : 'info',
        title: mail.subject,
        data: { id, boxId: c.boxId, confidence: c.confidence },
        link: mailLink(id),
      },
      deps.now(),
    );
  }
  return 'done';
}

/** A failure of this mail alone: gone from Gmail, refused by Google, a target that is no longer a box. */
const mailError = (err: unknown) =>
  err instanceof NotFoundError ||
  err instanceof BadRequestError ||
  (err instanceof GoogleApiError && (err.status === 404 || err.status === 400));

/** A failure that says nothing of the mail: the network, Google or the AI out for a while, the base held. */
const transientError = (err: unknown) =>
  (err instanceof TypeError && err.message === 'fetch failed') ||
  (err instanceof GoogleApiError && (err.status === 429 || err.status >= 500)) ||
  err instanceof GoogleReauthError ||
  err instanceof GoogleNotConnectedError ||
  // The AI unreachable or out for a while; another 4xx of the AI (a cut emoji, a bad setting) is no transient.
  (err instanceof ProviderError &&
    err.kind === 'unavailable' &&
    (err.status === undefined || err.status === 408 || err.status === 429 || err.status >= 500)) ||
  // node:sqlite: `code` is always ERR_SQLITE_ERROR, `errcode` the extended result code; SQLITE_BUSY is 5.
  ((err as { code?: unknown } | null)?.code === 'ERR_SQLITE_ERROR' &&
    ((err as { errcode: number }).errcode & 0xff) === 5);

/**
 * Triages the queued mails (the sync queues each new one; `ids` are queued too): rules first, then
 * the AI. Each mail is treated once (claimed before anything else); nothing happens under a local pause
 * (the queue waits); under a core pause only the rules run, the rest waits for the AI. After a credit error or a
 * refused key, the rest only gets the rules and waits for the AI; the next pass tries again.
 * A failure of the mail alone counts an attempt and the pass goes on; a transient one (network, Google, the AI, the
 * base held) gives the mail back without an attempt and stops the pass; any other counts an attempt and stops it.
 * At its third attempt a mail leaves the queue, to be filed by hand, and a line of the server log says so.
 */
export async function triageNew(deps: TriageDeps, ids: string[] = []): Promise<void> {
  enqueue(deps.db, ids, deps.now());
  const pass: Pass = { useAi: true, skipped: new Set(), log: deps.log ?? ((line) => console.log(line)) };
  const failed = (id: string, reason: string) => {
    if (failedAttempt(deps.db, id))
      pass.log(
        `Tri : mail ${id} sorti de la file après ${MAX_ATTEMPTS} essais, à trier à la main : ${reason}`,
      );
  };
  const waiting: string[] = [];
  try {
    await triageQueue(deps, pass, waiting, failed);
  } finally {
    // One signal for the screens, shaped as the sync's, even when a failure stopped the pass.
    if (waiting.length)
      emitEvent(
        deps.db,
        {
          type: 'mail.changed',
          importance: 'log',
          title: 'Boîte mise à jour',
          data: { added: [], changed: waiting, removed: [] },
        },
        deps.now(),
      );
  }
}

async function triageQueue(
  deps: TriageDeps,
  pass: Pass,
  waiting: string[],
  failed: (id: string, reason: string) => void,
): Promise<void> {
  for (const id of queuedIds(deps.db)) {
    const { pausedBy } = getState(deps.db);
    if (pausedBy === 'local') return;
    if (!claim(deps.db, id, deps.now())) {
      // Already decided; or being triaged by another pass, which will dequeue it.
      if (getProposal(deps.db, id)) dequeue(deps.db, id);
      continue;
    }
    let outcome: Outcome | 'ai-off' | 'pending';
    try {
      outcome = await triageOne(deps, id, { ...pass, useAi: pass.useAi && pausedBy !== 'core' });
    } catch (err) {
      release(deps.db, id);
      if (transientError(err)) throw err;
      failed(id, err instanceof Error ? err.message : String(err));
      if (mailError(err)) continue;
      throw err;
    }
    if (outcome === 'pending') {
      waiting.push(id);
      dequeue(deps.db, id);
    } else if (outcome === 'ai-off') pass.useAi = false;
    else if (outcome === 'unusable') failed(id, 'réponse inutilisable de l’IA');
    else if (outcome === 'done') dequeue(deps.db, id);
  }
}

function pendingProposal(db: DatabaseSync, id: string): Proposal {
  const p = getProposal(db, id);
  if (!p) throw new NotFoundError('Aucune proposition pour ce mail');
  if (p.status !== 'pending') throw new ConflictError('Cette proposition a déjà été traitée');
  return p;
}

function remember(deps: ActionDeps, id: string, boxId: string | null, tagIds: string[]): void {
  const mail = getStoredMessage(deps.db, id);
  if (mail) recordExample(deps.db, mail, boxId ?? 'none', tagIds, deps.now());
}

/** What an undo has to put back besides the labels. */
function snapshot(db: DatabaseSync, id: string): Previous {
  return { proposalStatus: getProposal(db, id)?.status ?? 'pending', example: getExample(db, id) };
}

/** The change a gesture made, or an empty one (same labels) when it moved nothing. */
const changeOf = (deps: ActionDeps, id: string, change: LabelChange | undefined): LabelChange => {
  if (change) return change;
  const labels = getStoredMessage(deps.db, id)?.labels ?? [];
  return { id, before: labels, after: labels };
};

// The mails a gesture is working on: a second gesture slipped in while Gmail answers would file and log twice.
const busy = new Set<string>();

/** Runs a gesture on a mail, unless another one is already running on it (`ConflictError`). */
async function oneAtATime<T>(id: string, gesture: () => Promise<T>): Promise<T> {
  if (busy.has(id)) throw new ConflictError('Un geste est déjà en cours sur ce mail');
  busy.add(id);
  try {
    return await gesture();
  } finally {
    busy.delete(id);
  }
}

/** CrOliX accepts the proposal as it is. */
export async function validate(deps: ActionDeps, id: string): Promise<Proposal & { journalId: number }> {
  return oneAtATime(id, async () => {
    const p = pendingProposal(deps.db, id);
    const previous = snapshot(deps.db, id);
    const change = await applyTarget(deps, id, p.boxId, p.tagIds);
    setProposalStatus(deps.db, id, 'accepted');
    remember(deps, id, p.boxId, p.tagIds);
    const journalId = logUser(deps.db, changeOf(deps, id, change), 'validate', deps.now(), previous);
    return { ...getProposal(deps.db, id)!, journalId };
  });
}

/** CrOliX says « not that »: the mail stays in the inbox, nothing is learnt, the line can be undone. */
export async function refuse(deps: ActionDeps, id: string): Promise<Proposal & { journalId: number }> {
  return oneAtATime(id, async () => {
    pendingProposal(deps.db, id);
    // Gmail is the truth, as for an undo: the cache may still say INBOX.
    const current = await fetchMetadata(deps.google, id);
    if (!current) throw new NotFoundError();
    upsertMessage(deps.db, current);
    const labels = current.labelIds ?? [];
    if (!labels.includes('INBOX') || labels.includes('TRASH') || labels.includes('SPAM'))
      throw new ConflictError('Ce mail n’est plus en boîte de réception');
    // Read again after the await: the proposal may have been settled meanwhile (a filing by hand, an undo).
    pendingProposal(deps.db, id);
    const previous = snapshot(deps.db, id);
    setProposalStatus(deps.db, id, 'refused');
    const journalId = logUser(deps.db, changeOf(deps, id, undefined), 'refuse', deps.now(), previous);
    return { ...getProposal(deps.db, id)!, journalId };
  });
}

/** The sender's bare address, lower case; `undefined` when none can be read. */
function senderAddress(deps: ActionDeps, id: string): string | undefined {
  const addr = getStoredMessage(deps.db, id)?.from.addr.trim().toLowerCase();
  return addr && /^[^\s@<>]+@[^\s@<>]+$/.test(addr) ? addr : undefined;
}

/** Files every mail of a sender in a box: one rule, last in line, unless the same one exists. */
function ruleForSender(deps: ActionDeps, id: string, boxId: string): Rule | undefined {
  // The rules only take boxes: the trash and the spam stay a gesture, never a standing order.
  if (!boxIds(deps.db).includes(boxId)) return;
  const addr = senderAddress(deps, id);
  if (!addr) return;
  const exists = listRules(deps.db).some(
    (r) =>
      r.field === 'from' && r.op === 'equals' && r.value.trim().toLowerCase() === addr && r.boxId === boxId,
  );
  return exists ? undefined : createRule(deps.db, { field: 'from', op: 'equals', value: addr, boxId });
}

/**
 * CrOliX files the mail elsewhere than proposed: the mail gets exactly these box and tags. A `null` box (a proposal
 * without one, corrected by the contract) leaves the mail where it is and sets its tags only.
 */
export async function correct(
  deps: ActionDeps,
  id: string,
  boxId: string | null,
  tagIds: string[],
  opts: { rememberSender?: boolean } = {},
): Promise<Proposal & { journalId: number }> {
  return oneAtATime(id, async () => {
    if (!getProposal(deps.db, id)) throw new NotFoundError('Aucune proposition pour ce mail');
    if (boxId !== null && boxId !== 'trash' && boxId !== 'spam' && !boxIds(deps.db).includes(boxId))
      throw new BadRequestError(`« ${boxId} » n’est pas une boîte`);
    const tags = new Set(listTags(deps.db).map((t) => t.id));
    const unknown = tagIds.find((t) => !tags.has(t));
    if (unknown) throw new BadRequestError(`« ${unknown} » n’est pas une étiquette`);
    const previous = snapshot(deps.db, id);
    const change = await applyTarget(deps, id, boxId, tagIds, true);
    setProposalStatus(deps.db, id, 'corrected');
    remember(deps, id, boxId, tagIds);
    const createdRule = opts.rememberSender && boxId ? ruleForSender(deps, id, boxId) : undefined;
    if (createdRule) previous.createdRule = createdRule;
    const journalId = logUser(deps.db, changeOf(deps, id, change), 'correct', deps.now(), previous);
    return { ...getProposal(deps.db, id)!, journalId };
  });
}

/**
 * A mail filed by hand is a human gesture too: it becomes an example, and a pending proposal for it, or one the AI
 * filed alone, is settled (accepted when it named the same box, corrected otherwise).
 */
export function onManualFile(deps: ActionDeps, id: string, boxId: string): void {
  const mail = getStoredMessage(deps.db, id);
  if (!mail) return;
  recordExample(deps.db, mail, boxId, tagIdsOf(deps.db, mail.labels), deps.now());
  const p = getProposal(deps.db, id);
  if (p?.status === 'pending' || (p?.source === 'ai' && p.status === 'auto'))
    setProposalStatus(deps.db, id, p.boxId === boxId ? 'accepted' : 'corrected');
}

const JOURNALED: Partial<Record<BatchOp['kind'], UserAction>> = {
  file: 'file',
  archive: 'archive',
  trash: 'trash',
  spam: 'spam',
};

/**
 * Called after a mail action done by hand: a filing is learned (`onManualFile`), then the gesture is
 * journaled so that it can be undone. Returns its journal id, or `undefined` for the actions the
 * journal does not keep (read, tags, untrash).
 */
export function afterUserAction(deps: ActionDeps, change: LabelChange, op: BatchOp): number | undefined {
  const action = JOURNALED[op.kind];
  if (!action) return undefined;
  const previous = snapshot(deps.db, change.id);
  if (op.kind === 'file') onManualFile(deps, change.id, op.boxId);
  return logUser(deps.db, change, action, deps.now(), previous);
}

/** Adds its proposal to a listed mail. */
export function withProposal(db: DatabaseSync, m: StoredMessage): StoredMessage {
  const p = getProposal(db, m.id);
  return p ? { ...m, proposal: proposalView(p, isBulk(db, p)) } : m;
}
