import { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { requireToken } from '../contract/auth.ts';
import { GoogleApiError, type GoogleClient } from '../google/client.ts';
import type { MailDetail, MailSummary } from '../types.ts';
import { findPart, renderBody, type GmailPart } from './body.ts';
import {
  getStoredMessage,
  header,
  listView,
  parseAddress,
  upsertMessage,
  viewFilter,
  type StoredMessage,
} from './store.ts';
import { fetchMetadata, GMAIL_API } from './sync.ts';

interface FullMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  payload: GmailPart;
}

/** What the API shows of a cached message (internal fields dropped). */
export function summary(m: StoredMessage): MailSummary {
  const s: MailSummary = {
    id: m.id,
    threadId: m.threadId,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet,
    date: m.date,
    unread: m.unread,
    labels: m.labels,
  };
  if (m.box) s.box = m.box;
  if (m.proposal) s.proposal = m.proposal;
  return s;
}

/** Hook for later tasks to enrich a listed mail (its box, a pending proposal). */
export type Decorate = (m: StoredMessage) => StoredMessage;

async function search(deps: AppDeps, google: GoogleClient, q: string, cursor?: string) {
  const params = new URLSearchParams({ q, maxResults: '50' });
  if (cursor) params.set('pageToken', cursor);
  const page = await google.request<{ messages?: { id: string }[]; nextPageToken?: string }>(
    'GET',
    `${GMAIL_API}/messages?${params}`,
  );
  const items: StoredMessage[] = [];
  for (const { id } of page.messages ?? []) {
    let m = getStoredMessage(deps.db, id);
    if (!m) {
      const meta = await fetchMetadata(google, id);
      if (!meta) continue;
      upsertMessage(deps.db, meta);
      m = getStoredMessage(deps.db, id);
    }
    if (m) items.push(m);
  }
  return { items, cursor: page.nextPageToken };
}

export function gmailRoutes(
  deps: AppDeps,
  google: GoogleClient | undefined,
  decorate: Decorate = (m) => m,
): Hono {
  const r = new Hono();
  r.use('*', requireToken(deps.db));
  r.use('*', async (c, next) => {
    if (!google) return c.json({ error: 'Google n’est pas configuré sur ce serveur' }, 503);
    await next();
  });

  r.get('/', async (c) => {
    const q = c.req.query('q');
    const cursor = c.req.query('cursor');
    if (q) {
      const found = await search(deps, google!, q, cursor);
      const body: { items: MailSummary[]; cursor?: string } = {
        items: found.items.map((m) => summary(decorate(m))),
      };
      if (found.cursor) body.cursor = found.cursor;
      return c.json(body);
    }
    const view = c.req.query('view') ?? 'inbox';
    if (view === 'pending') return c.json({ items: [] });
    const filter = viewFilter(view);
    if (!filter) return c.json({ error: `Vue inconnue : ${view}` }, 400);
    const page = listView(deps.db, filter, cursor);
    const body: { items: MailSummary[]; cursor?: string } = {
      items: page.items.map((m) => summary(decorate(m))),
    };
    if (page.cursor) body.cursor = page.cursor;
    return c.json(body);
  });

  async function full(id: string): Promise<FullMessage | undefined> {
    try {
      return await google!.request<FullMessage>(
        'GET',
        `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`,
      );
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  r.get('/:id', async (c) => {
    const m = await full(c.req.param('id'));
    if (!m) return c.json({ error: 'Mail introuvable' }, 404);
    upsertMessage(deps.db, m);
    const stored = decorate(getStoredMessage(deps.db, m.id)!);
    const { html, attachments } = await renderBody(m.payload, async (attachmentId) => {
      const att = await google!.request<{ data: string }>(
        'GET',
        `${GMAIL_API}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
      return att.data;
    });
    const detail: MailDetail = {
      ...summary(stored),
      from: parseAddress(header(m, 'From')),
      to: header(m, 'To'),
      html,
      attachments,
    };
    const cc = header(m, 'Cc');
    if (cc) detail.cc = cc;
    return c.json(detail);
  });

  r.get('/:id/attachments/:partId', async (c) => {
    const m = await full(c.req.param('id'));
    const part = m && findPart(m.payload, c.req.param('partId'));
    if (!m || !part) return c.json({ error: 'Pièce jointe introuvable' }, 404);
    const data =
      part.body?.data ??
      (
        await google!.request<{ data: string }>(
          'GET',
          `${GMAIL_API}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(part.body?.attachmentId ?? '')}`,
        )
      ).data;
    const filename = (part.filename ?? 'piece-jointe').replace(/["\r\n]/g, '');
    return new Response(Buffer.from(data, 'base64url'), {
      headers: {
        'content-type': part.mimeType ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  });

  return r;
}
