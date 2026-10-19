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
  type LabelChange,
} from '../gmail/actions.ts';
import { plainText } from '../gmail/body.ts';
import { getStoredMessage, header, type StoredMessage } from '../gmail/store.ts';
import { fetchFull } from '../gmail/read.ts';
import { ClassifierError, CreditExhaustedError, type Classification, type Classifier } from './classifier.ts';
import { pickExamples, recordExample } from './examples.ts';
import { ConflictError, logAuto } from './journal.ts';
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
import { listRules, matchRule } from './rules.ts';

export { getProposal };

export interface TriageDeps extends ActionDeps {
  /** Absent without ANTHROPIC_API_KEY: only the rules run. */
  classifier?: Classifier | undefined;
}

/** Confidence the AI needs to file a mail on its own; 100 means every AI proposal waits. */
export const DEFAULT_THRESHOLD = 100;
/** A mail never goes to spam on a lower confidence, whatever the threshold. */
export const SPAM_CONFIDENCE = 95;

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
): Promise<Classification | 'credit' | undefined> {
  const payload = (await fetchFull(deps.google, mail.id))?.payload;
  if (!payload) return undefined;
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
      return 'credit';
    }
    if (err instanceof ClassifierError) return undefined;
    throw err;
  }
}

/** Triages one claimed mail; returns `credit` when the AI ran out of credit. */
async function triageOne(deps: TriageDeps, id: string, useAi: boolean): Promise<'credit' | undefined> {
  const mail = getStoredMessage(deps.db, id);
  // A mail already out of the inbox (a Gmail filter, a gesture) is left where it is.
  if (!mail?.labels.includes('INBOX')) {
    release(deps.db, id);
    return undefined;
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
    return undefined;
  }

  const classifier = deps.classifier;
  if (!classifier || !useAi) {
    release(deps.db, id);
    return undefined;
  }
  const c = await classify({ ...deps, classifier }, mail);
  if (c === undefined || c === 'credit') {
    release(deps.db, id);
    return c;
  }

  const urgent = c.importance === 'urgent' ? listTags(deps.db).find((t) => isUrgentName(t.name)) : undefined;
  const tagIds = urgent && !c.tagIds.includes(urgent.id) ? [...c.tagIds, urgent.id] : c.tagIds;
  const auto =
    c.boxId !== null &&
    c.confidence >= getThreshold(deps.db) &&
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
  return undefined;
}

/**
 * Triages the mails a sync just brought in: rules first, then the AI. Each mail is treated once
 * (claimed before anything else); nothing happens while paused. After a credit error, the rest of
 * the batch only gets the rules; the next batch tries the AI again.
 */
export async function triageNew(deps: TriageDeps, ids: string[]): Promise<void> {
  let useAi = true;
  for (const id of ids) {
    if (getState(deps.db).paused) return;
    if (!claim(deps.db, id, deps.now())) continue;
    try {
      if ((await triageOne(deps, id, useAi)) === 'credit') useAi = false;
    } catch (err) {
      release(deps.db, id);
      throw err;
    }
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

/** CrOliX accepts the proposal as it is. */
export async function validate(deps: ActionDeps, id: string): Promise<Proposal> {
  const p = pendingProposal(deps.db, id);
  await applyTarget(deps, id, p.boxId, p.tagIds);
  setProposalStatus(deps.db, id, 'accepted');
  remember(deps, id, p.boxId, p.tagIds);
  return getProposal(deps.db, id)!;
}

/** CrOliX files the mail elsewhere than proposed: the mail gets exactly these box and tags. */
export async function correct(
  deps: ActionDeps,
  id: string,
  boxId: string,
  tagIds: string[],
): Promise<Proposal> {
  if (!getProposal(deps.db, id)) throw new NotFoundError('Aucune proposition pour ce mail');
  if (boxId !== 'trash' && boxId !== 'spam' && !boxIds(deps.db).includes(boxId))
    throw new BadRequestError(`« ${boxId} » n’est pas une boîte`);
  const tags = new Set(listTags(deps.db).map((t) => t.id));
  const unknown = tagIds.find((t) => !tags.has(t));
  if (unknown) throw new BadRequestError(`« ${unknown} » n’est pas une étiquette`);
  await applyTarget(deps, id, boxId, tagIds, true);
  setProposalStatus(deps.db, id, 'corrected');
  remember(deps, id, boxId, tagIds);
  return getProposal(deps.db, id)!;
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

/** Adds its proposal to a listed mail. */
export function withProposal(db: DatabaseSync, m: StoredMessage): StoredMessage {
  const p = getProposal(db, m.id);
  return p ? { ...m, proposal: proposalView(p) } : m;
}
