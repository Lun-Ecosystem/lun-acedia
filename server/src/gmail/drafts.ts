import { GoogleApiError } from '../google/client.ts';
import type { DraftView } from '../types.ts';
import { NotFoundError, type ActionDeps } from './actions.ts';
import { plainText, type GmailPart } from './body.ts';
import { rawMessage, type Draft } from './compose.ts';
import { GMAIL_API } from './sync.ts';

interface GmailDraft {
  id: string;
  message: { threadId: string; payload?: GmailPart };
}

const url = (id = '') => `${GMAIL_API}/drafts${id && `/${encodeURIComponent(id)}`}`;

/** Gmail answers 404 for an unknown draft. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) throw new NotFoundError('Brouillon introuvable');
    throw err;
  }
}

function view(d: GmailDraft): DraftView {
  const payload = d.message.payload;
  const h = (name: string) =>
    payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const out: DraftView = {
    id: d.id,
    to: h('To'),
    subject: h('Subject'),
    text: payload ? plainText(payload) : '',
  };
  if (h('Cc')) out.cc = h('Cc');
  if (h('In-Reply-To')) out.replyTo = { id: h('In-Reply-To'), threadId: d.message.threadId };
  return out;
}

/** Saves the draft in Gmail's drafts; it is never sent from here. */
export async function createDraft(deps: ActionDeps, draft: Draft): Promise<DraftView> {
  const message = await rawMessage(deps, draft);
  const { id } = await guarded(() => deps.google.request<{ id: string }>('POST', url(), { message }));
  return getDraft(deps, id);
}

export const getDraft = (deps: ActionDeps, id: string) =>
  guarded(async () => view(await deps.google.request<GmailDraft>('GET', `${url(id)}?format=full`)));

export async function updateDraft(deps: ActionDeps, id: string, draft: Draft): Promise<DraftView> {
  const message = await rawMessage(deps, draft);
  await guarded(() => deps.google.request('PUT', url(id), { message }));
  return getDraft(deps, id);
}

export async function deleteDraft(deps: ActionDeps, id: string): Promise<{ ok: true }> {
  await guarded(() => deps.google.request('DELETE', url(id)));
  return { ok: true };
}

/** The only way a mail leaves from a draft: called by the screen, never by the catalog. */
export const sendDraft = (deps: ActionDeps, id: string) =>
  guarded(() => deps.google.request<{ id: string; threadId: string }>('POST', `${url()}/send`, { id }));
