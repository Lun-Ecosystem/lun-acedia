import type { DatabaseSync } from 'node:sqlite';
import { GoogleApiError, type GoogleClient } from '../google/client.ts';
import { getStoredMessage, setStoredLabels, upsertMessage } from './store.ts';
import { fetchMetadata, GMAIL_API } from './sync.ts';

export interface ActionDeps {
  db: DatabaseSync;
  google: GoogleClient;
  now: () => Date;
}

export interface LabelChange {
  id: string;
  before: string[];
  after: string[];
}

export class NotFoundError extends Error {
  constructor(message = 'Mail introuvable') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

export type BatchOp =
  | { kind: 'file'; boxId: string }
  | { kind: 'archive' }
  | { kind: 'trash' }
  | { kind: 'untrash' }
  | { kind: 'spam' }
  | { kind: 'read'; read: boolean }
  | { kind: 'tags'; add: string[]; remove: string[] };

/** Label ids that are boxes (Task 6 lets CrOliX choose them). */
export function boxIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT label_id FROM label_roles WHERE role = 'box'").all() as { label_id: string }[]
  ).map((r) => r.label_id);
}

async function currentLabels(deps: ActionDeps, id: string): Promise<string[]> {
  const cached = getStoredMessage(deps.db, id);
  if (cached) return cached.labels;
  const meta = await fetchMetadata(deps.google, id);
  if (!meta) throw new NotFoundError();
  upsertMessage(deps.db, meta);
  return meta.labelIds ?? [];
}

async function post(deps: ActionDeps, id: string, verb: string, body?: unknown): Promise<string[]> {
  try {
    const res = await deps.google.request<{ labelIds?: string[] }>(
      'POST',
      `${GMAIL_API}/messages/${encodeURIComponent(id)}/${verb}`,
      body,
    );
    return res.labelIds ?? [];
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) throw new NotFoundError();
    throw err;
  }
}

/** Changes a mail's labels in Gmail and updates the cache at once. */
export async function modifyLabels(
  deps: ActionDeps,
  id: string,
  add: string[],
  remove: string[],
): Promise<LabelChange> {
  const before = await currentLabels(deps, id);
  const after = await post(deps, id, 'modify', { addLabelIds: add, removeLabelIds: remove });
  setStoredLabels(deps.db, id, after);
  return { id, before, after };
}

/** Moves a mail into a box: the box is added, the inbox and any other box removed. */
export async function fileMail(deps: ActionDeps, id: string, boxLabelId: string): Promise<LabelChange> {
  const boxes = boxIds(deps.db);
  if (!boxes.includes(boxLabelId)) throw new BadRequestError(`« ${boxLabelId} » n’est pas une boîte`);
  const before = await currentLabels(deps, id);
  const remove = before.filter((l) => l === 'INBOX' || (boxes.includes(l) && l !== boxLabelId));
  return modifyLabels(deps, id, [boxLabelId], remove);
}

async function moveToTrash(deps: ActionDeps, id: string, verb: 'trash' | 'untrash'): Promise<LabelChange> {
  const before = await currentLabels(deps, id);
  const after = await post(deps, id, verb);
  setStoredLabels(deps.db, id, after);
  return { id, before, after };
}

/** To the trash, never a permanent deletion. */
export const trashMail = (deps: ActionDeps, id: string) => moveToTrash(deps, id, 'trash');
export const untrashMail = (deps: ActionDeps, id: string) => moveToTrash(deps, id, 'untrash');
export const archiveMail = (deps: ActionDeps, id: string) => modifyLabels(deps, id, [], ['INBOX']);
export const reportSpam = (deps: ActionDeps, id: string) => modifyLabels(deps, id, ['SPAM'], ['INBOX']);
export const markRead = (deps: ActionDeps, id: string, read: boolean) =>
  read ? modifyLabels(deps, id, [], ['UNREAD']) : modifyLabels(deps, id, ['UNREAD'], []);
export const setTags = (deps: ActionDeps, id: string, add: string[], remove: string[]) =>
  modifyLabels(deps, id, add, remove);

export function applyOp(deps: ActionDeps, id: string, op: BatchOp): Promise<LabelChange> {
  switch (op.kind) {
    case 'file':
      return fileMail(deps, id, op.boxId);
    case 'archive':
      return archiveMail(deps, id);
    case 'trash':
      return trashMail(deps, id);
    case 'untrash':
      return untrashMail(deps, id);
    case 'spam':
      return reportSpam(deps, id);
    case 'read':
      return markRead(deps, id, op.read);
    case 'tags':
      return setTags(deps, id, op.add, op.remove);
  }
}

/** One message at a time, so that each change can be journaled and undone on its own. */
export async function batch(deps: ActionDeps, ids: string[], op: BatchOp): Promise<LabelChange[]> {
  const changes: LabelChange[] = [];
  for (const id of ids) changes.push(await applyOp(deps, id, op));
  return changes;
}
