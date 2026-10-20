import type { DatabaseSync } from 'node:sqlite';
import { emitEvent } from '../contract/events.ts';
import { GoogleApiError, type GoogleClient } from '../google/client.ts';
import { enqueue } from '../triage/queue.ts';
import { startLoop } from '../util.ts';
import {
  getStoredMessage,
  getSyncState,
  removeMessage,
  saveLabels,
  setSyncState,
  storedIds,
  upsertMessage,
  type GmailMessage,
} from './store.ts';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const INITIAL_MAILS = 500;
const INITIAL_SPAM_TRASH = 100;
const CONCURRENCY = 8;

export interface SyncDeps {
  db: DatabaseSync;
  google: GoogleClient;
  now: () => Date;
  /** How many recent mails the first listing caches (500). */
  initialMails?: number;
}

export interface SyncResult {
  /** Incoming mails that arrived after the first connection: the input of the triage. */
  added: string[];
  changed: string[];
  removed: string[];
}

export function metadataUrl(id: string): string {
  return (
    `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata` +
    '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject'
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Fetches a message's metadata; `undefined` when Gmail no longer has it. */
export async function fetchMetadata(google: GoogleClient, id: string): Promise<GmailMessage | undefined> {
  try {
    return await google.request<GmailMessage>('GET', metadataUrl(id));
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) return undefined;
    throw err;
  }
}

async function listIds(google: GoogleClient, max: number, q?: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: String(Math.min(max - ids.length, 500)) });
    if (q) params.set('q', q);
    if (pageToken) params.set('pageToken', pageToken);
    const page = await google.request<{ messages?: { id: string }[]; nextPageToken?: string }>(
      'GET',
      `${GMAIL_API}/messages?${params}`,
    );
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

function isIncoming(labels: string[]): boolean {
  return labels.includes('INBOX') && !labels.includes('DRAFT');
}

async function refreshLabels(deps: SyncDeps): Promise<void> {
  const { labels } = await deps.google.request<{ labels: { id: string; name: string; type: string }[] }>(
    'GET',
    `${GMAIL_API}/labels`,
  );
  saveLabels(deps.db, labels);
}

/** Lists everything again: on the first connection, and when Gmail forgot our history point. */
async function fullSync(deps: SyncDeps, initial: boolean): Promise<SyncResult> {
  const { db, google } = deps;
  const profile = await google.request<{ historyId: string }>('GET', `${GMAIL_API}/profile`);
  const maxMails = deps.initialMails ?? INITIAL_MAILS;
  const recent = await listIds(google, maxMails);
  const spamTrash = await listIds(google, INITIAL_SPAM_TRASH, 'in:spam OR in:trash');
  const ids = [...recent, ...spamTrash];
  // Whether the cache holds the whole mailbox, or the views must ask Gmail past its end.
  const complete = recent.length < maxMails && spamTrash.length < INITIAL_SPAM_TRASH;
  const before = storedIds(db);
  const previousLabels = new Map([...before].map((id) => [id, getStoredMessage(db, id)?.labels.join(',')]));
  const connectedAt = Number(getSyncState(db, 'gmail.connectedAt') ?? deps.now().getTime());
  const result: SyncResult = { added: [], changed: [], removed: [] };
  const fetched = await mapLimit(ids, CONCURRENCY, (id) => fetchMetadata(google, id));
  const seen = new Set<string>();
  for (const m of fetched) {
    if (!m) continue;
    seen.add(m.id);
    upsertMessage(db, m);
    const labels = m.labelIds ?? [];
    if (!before.has(m.id)) {
      if (!initial && isIncoming(labels) && Number(m.internalDate) >= connectedAt) result.added.push(m.id);
    } else if (previousLabels.get(m.id) !== labels.join(',')) result.changed.push(m.id);
  }
  // The listing stops at the most recent mails: an older cached one is gone only if Gmail says so.
  const unseen = [...before].filter((id) => !seen.has(id));
  const checked = await mapLimit(
    unseen,
    CONCURRENCY,
    async (id) => [id, await fetchMetadata(google, id)] as const,
  );
  for (const [id, m] of checked) {
    if (!m) {
      removeMessage(db, id);
      result.removed.push(id);
      continue;
    }
    upsertMessage(db, m);
    if (previousLabels.get(id) !== (m.labelIds ?? []).join(',')) result.changed.push(id);
  }
  enqueue(db, result.added, deps.now());
  setSyncState(db, 'gmail.historyId', profile.historyId);
  setSyncState(db, 'gmail.complete', complete ? '1' : '0');
  if (initial) setSyncState(db, 'gmail.connectedAt', String(connectedAt));
  return result;
}

interface HistoryPage {
  history?: {
    messagesAdded?: { message: { id: string } }[];
    messagesDeleted?: { message: { id: string } }[];
    labelsAdded?: { message: { id: string } }[];
    labelsRemoved?: { message: { id: string } }[];
  }[];
  historyId: string;
  nextPageToken?: string;
}

async function incrementalSync(deps: SyncDeps, startHistoryId: string): Promise<SyncResult> {
  const { db, google } = deps;
  const addedIds = new Set<string>();
  const touched = new Set<string>();
  const deleted = new Set<string>();
  let pageToken: string | undefined;
  let historyId: string | undefined;
  do {
    const params = new URLSearchParams({ startHistoryId });
    for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
      params.append('historyTypes', t);
    }
    if (pageToken) params.set('pageToken', pageToken);
    const page = await google.request<HistoryPage>('GET', `${GMAIL_API}/history?${params}`);
    for (const h of page.history ?? []) {
      for (const a of h.messagesAdded ?? []) addedIds.add(a.message.id);
      for (const d of h.messagesDeleted ?? []) deleted.add(d.message.id);
      for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) touched.add(l.message.id);
    }
    historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const before = storedIds(db);
  const result: SyncResult = { added: [], changed: [], removed: [] };
  const toFetch = [...new Set([...addedIds, ...touched])].filter((id) => !deleted.has(id));
  const fetched = await mapLimit(
    toFetch,
    CONCURRENCY,
    async (id) => [id, await fetchMetadata(google, id)] as const,
  );
  for (const [id, m] of fetched) {
    if (!m) {
      if (before.has(id)) deleted.add(id);
      continue;
    }
    const previous = getStoredMessage(db, id)?.labels.join(',');
    upsertMessage(db, m);
    const labels = m.labelIds ?? [];
    // New is what Gmail says arrived, even if a read or a search cached it a moment earlier.
    if (addedIds.has(id) && isIncoming(labels)) result.added.push(id);
    else if (before.has(id) && previous !== labels.join(',')) result.changed.push(id);
  }
  for (const id of deleted) {
    if (before.has(id)) {
      removeMessage(db, id);
      result.removed.push(id);
    }
  }
  enqueue(db, result.added, deps.now());
  setSyncState(db, 'gmail.historyId', historyId ?? startHistoryId);
  return result;
}

/** Brings the cache up to date with Gmail, the source of truth. */
export async function syncGmail(deps: SyncDeps): Promise<SyncResult> {
  await refreshLabels(deps);
  const historyId = getSyncState(deps.db, 'gmail.historyId');
  let result: SyncResult;
  if (!historyId) result = await fullSync(deps, true);
  else {
    try {
      result = await incrementalSync(deps, historyId);
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
      result = await fullSync(deps, false);
    }
  }
  if (result.added.length || result.changed.length || result.removed.length) {
    emitEvent(
      deps.db,
      { type: 'mail.changed', importance: 'info', title: 'Boîte mise à jour', data: result },
      deps.now(),
    );
  }
  return result;
}

/**
 * Runs `syncGmail` every `intervalMs`, never two at a time; `onResult` receives each result (the
 * triage plugs in there). Errors are passed to `onError` and the loop goes on.
 */
export function startSyncLoop(
  deps: SyncDeps,
  opts: {
    intervalMs?: number;
    onResult?: (r: SyncResult) => Promise<void> | void;
    onError?: (err: unknown) => void;
  } = {},
): { stop: () => void; runNow: () => Promise<void> } {
  return startLoop(
    async () => {
      const result = await syncGmail(deps);
      await opts.onResult?.(result);
    },
    {
      intervalMs: opts.intervalMs ?? Number(process.env.SYNC_INTERVAL_MS ?? 60_000),
      ...(opts.onError ? { onError: opts.onError } : {}),
    },
  );
}
