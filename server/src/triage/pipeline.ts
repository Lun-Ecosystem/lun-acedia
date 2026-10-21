import type { DatabaseSync } from 'node:sqlite';
import { recordCost } from '../contract/costs.ts';
import { emitEvent } from '../contract/events.ts';
import { addDegraded, clearDegraded, getState } from '../contract/state.ts';
import { getSetting } from '../db.ts';
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
import { plainText } from '../gmail/body.ts';
import { getStoredMessage, header, type StoredMessage } from '../gmail/store.ts';
import { fetchFull } from '../gmail/read.ts';
import { keyRefused, keyWorks } from '../keys/anthropic-key.ts';
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
import { costOf } from './prices.ts';
import {
  claim,
  getProposal,
  proposalView,
  release,
  saveProposal,
  setProposalStatus,
  type Proposal,
} from './proposals.ts';
import { dequeue, enqueue, failedAttempt, queuedIds } from './queue.ts';
import { createRule, listRules, matchRule } from './rules.ts';

export { getProposal };

export interface TriageDeps extends ActionDeps {
  /** Absent without an Anthropic key (saved or in `.env`): only the rules run. */
  classifier?: Classifier | undefined;
}

/** Confidence the AI needs to file a mail on its own; 100 means every AI proposal waits. */
export const DEFAULT_THRESHOLD = 100;
/** A mail never goes to spam on a lower confidence, whatever the threshold. */
export const SPAM_CONFIDENCE = 95;

/** Confidence from which « Tout valider » validates a proposal; never above the threshold. */
export const DEFAULT_BULK_THRESHOLD = 85;

export const getThreshold = (db: DatabaseSync) => getSetting(db, 'threshold', DEFAULT_THRESHOLD);

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

function creditExhausted(deps: ActionDeps): void {
  if (getState(deps.db).degraded.includes('credit')) return;
  addDegraded(deps.db, 'credit');
  emitEvent(
    deps.db,
    {
      type: 'credit.exhausted',
      importance: 'urgent',
      title: 'Crédit IA épuisé : le tri par l’IA est en pause, les règles continuent',
    },
    deps.now(),
  );
}

async function classify(
  deps: TriageDeps & { classifier: Classifier },
  mail: StoredMessage,
): Promise<Classification | 'ai-off' | 'gone' | 'unusable'> {
  const payload = (await fetchFull(deps.google, mail.id))?.payload;
  if (!payload) return 'gone';
  try {
    const result = await deps.classifier.classify({
      mail: {
        from: header({ payload }, 'From'),
        to: header({ payload }, 'To'),
        subject: mail.subject,
        date: mail.date,
        text: plainText(payload),
      },
      boxes: listBoxes(deps.db),
      tags: listTags(deps.db),
      examples: pickExamples(deps.db, mail),
    });
    if (getState(deps.db).degraded.includes('credit')) clearDegraded(deps.db, 'credit');
    keyWorks(deps.db, deps.now());
    recordCost(
      deps.db,
      {
        provider: 'anthropic',
        model: deps.classifier.model,
        amount: costOf(deps.classifier.model, result.usage),
        calls: 1,
      },
      deps.now(),
    );
    return result;
  } catch (err) {
    if (err instanceof CreditExhaustedError) {
      creditExhausted(deps);
      return 'ai-off';
    }
    if (err instanceof KeyRefusedError) {
      keyRefused(deps.db, deps.now());
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

/** Triages one claimed mail; `ai-off` when the AI just ran out of credit or refused the key. */
async function triageOne(deps: TriageDeps, id: string, useAi: boolean): Promise<Outcome | 'ai-off'> {
  const mail = getStoredMessage(deps.db, id);
  // A mail already out of the inbox (a Gmail filter, a gesture) is left where it is.
  if (!mail?.labels.includes('INBOX')) {
    release(deps.db, id);
    return 'done';
  }

  const rule = matchRule(listRules(deps.db), mail);
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
    emitEvent(
      deps.db,
      { type: 'mail.triaged', importance: 'info', title: mail.subject, data: { id, boxId: rule.boxId } },
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
  if (!useAi) {
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
    source: 'ai',
    status: auto ? 'auto' : 'pending',
  });
  if (c.importance !== 'none') {
    emitEvent(
      deps.db,
      {
        type: auto ? 'mail.triaged' : 'mail.pending',
        importance: c.importance,
        title: mail.subject,
        data: { id, boxId: c.boxId, confidence: c.confidence },
      },
      deps.now(),
    );
  }
  return 'done';
}

/**
 * Triages the queued mails (the sync queues each new one; `ids` are queued too): rules first, then
 * the AI. Each mail is treated once (claimed before anything else); nothing happens while paused,
 * and the queue waits. After a credit error or a refused key, the rest only gets the rules and waits
 * for the AI; the next pass tries again. A failure stops the pass and leaves the mail queued.
 */
export async function triageNew(deps: TriageDeps, ids: string[] = []): Promise<void> {
  enqueue(deps.db, ids, deps.now());
  let useAi = true;
  for (const id of queuedIds(deps.db)) {
    if (getState(deps.db).paused) return;
    if (!claim(deps.db, id, deps.now())) {
      // Already decided; or being triaged by another pass, which will dequeue it.
      if (getProposal(deps.db, id)) dequeue(deps.db, id);
      continue;
    }
    let outcome: Outcome | 'ai-off';
    try {
      outcome = await triageOne(deps, id, useAi);
    } catch (err) {
      release(deps.db, id);
      failedAttempt(deps.db, id);
      throw err;
    }
    if (outcome === 'ai-off') useAi = false;
    else if (outcome === 'unusable') failedAttempt(deps.db, id);
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

/** CrOliX accepts the proposal as it is. */
export async function validate(deps: ActionDeps, id: string): Promise<Proposal & { journalId: number }> {
  const p = pendingProposal(deps.db, id);
  const previous = snapshot(deps.db, id);
  const change = await applyTarget(deps, id, p.boxId, p.tagIds);
  setProposalStatus(deps.db, id, 'accepted');
  remember(deps, id, p.boxId, p.tagIds);
  const journalId = logUser(deps.db, changeOf(deps, id, change), 'validate', deps.now(), previous);
  return { ...getProposal(deps.db, id)!, journalId };
}

/** The sender's bare address, lower case; `undefined` when none can be read. */
function senderAddress(deps: ActionDeps, id: string): string | undefined {
  const addr = getStoredMessage(deps.db, id)?.from.addr.trim().toLowerCase();
  return addr && /^[^\s@<>]+@[^\s@<>]+$/.test(addr) ? addr : undefined;
}

/** Files every mail of a sender in a box: one rule, last in line, unless the same one exists. */
function ruleForSender(deps: ActionDeps, id: string, boxId: string): number | undefined {
  // The rules only take boxes: the trash and the spam stay a gesture, never a standing order.
  if (!boxIds(deps.db).includes(boxId)) return;
  const addr = senderAddress(deps, id);
  if (!addr) return;
  const exists = listRules(deps.db).some(
    (r) =>
      r.field === 'from' && r.op === 'equals' && r.value.trim().toLowerCase() === addr && r.boxId === boxId,
  );
  return exists ? undefined : createRule(deps.db, { field: 'from', op: 'equals', value: addr, boxId }).id;
}

/** CrOliX files the mail elsewhere than proposed: the mail gets exactly these box and tags. */
export async function correct(
  deps: ActionDeps,
  id: string,
  boxId: string,
  tagIds: string[],
  opts: { rememberSender?: boolean } = {},
): Promise<Proposal & { journalId: number }> {
  if (!getProposal(deps.db, id)) throw new NotFoundError('Aucune proposition pour ce mail');
  if (boxId !== 'trash' && boxId !== 'spam' && !boxIds(deps.db).includes(boxId))
    throw new BadRequestError(`« ${boxId} » n’est pas une boîte`);
  const tags = new Set(listTags(deps.db).map((t) => t.id));
  const unknown = tagIds.find((t) => !tags.has(t));
  if (unknown) throw new BadRequestError(`« ${unknown} » n’est pas une étiquette`);
  const previous = snapshot(deps.db, id);
  const change = await applyTarget(deps, id, boxId, tagIds, true);
  setProposalStatus(deps.db, id, 'corrected');
  remember(deps, id, boxId, tagIds);
  const createdRuleId = opts.rememberSender ? ruleForSender(deps, id, boxId) : undefined;
  if (createdRuleId !== undefined) previous.createdRuleId = createdRuleId;
  const journalId = logUser(deps.db, changeOf(deps, id, change), 'correct', deps.now(), previous);
  return { ...getProposal(deps.db, id)!, journalId };
}

/**
 * A mail filed by hand is a human gesture too: it becomes an example, and a pending proposal for it
 * is settled (accepted when it named the same box).
 */
export function onManualFile(deps: ActionDeps, id: string, boxId: string): void {
  const mail = getStoredMessage(deps.db, id);
  if (!mail) return;
  recordExample(deps.db, mail, boxId, tagIdsOf(deps.db, mail.labels), deps.now());
  const p = getProposal(deps.db, id);
  if (p?.status === 'pending') setProposalStatus(deps.db, id, p.boxId === boxId ? 'accepted' : 'corrected');
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
  return p ? { ...m, proposal: proposalView(p) } : m;
}
