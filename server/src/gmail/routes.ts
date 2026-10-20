import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { stripUndefined } from '../util.ts';
import { requireToken } from '../contract/auth.ts';
import type { GoogleClient } from '../google/client.ts';
import type { MailSummary } from '../types.ts';
import { applyOp, BadRequestError, batch, NotFoundError, type ActionDeps, type BatchOp } from './actions.ts';
import { findPart } from './body.ts';
import { defaultFrom, sendMail } from './compose.ts';
import { fetchFull, readMail, searchMail, summary } from './read.ts';
import { listView, viewFilter, type StoredMessage } from './store.ts';
import { GMAIL_API } from './sync.ts';

/** What the triage plugs into the mail routes. */
export interface MailHooks {
  /** Enriches a listed mail (its proposal). */
  decorate?: (m: StoredMessage) => StoredMessage;
  /** Called after each mail filed by hand. */
  onFile?: (id: string, boxId: string) => void;
}

export function gmailRoutes(deps: AppDeps, google: GoogleClient | undefined, hooks: MailHooks = {}): Hono {
  const decorate = hooks.decorate ?? ((m: StoredMessage) => m);
  const filed = (ids: string[], op: BatchOp) => {
    if (op.kind === 'file') for (const id of ids) hooks.onFile?.(id, op.boxId);
  };
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
      const found = await searchMail(deps.db, google!, q, cursor);
      const body: { items: MailSummary[]; cursor?: string } = {
        items: found.items.map((m) => summary(decorate(m))),
      };
      if (found.cursor) body.cursor = found.cursor;
      return c.json(body);
    }
    const view = c.req.query('view') ?? 'inbox';
    const filter = viewFilter(view);
    if (!filter) return c.json({ error: `Vue inconnue : ${view}` }, 400);
    const page = listView(deps.db, filter, cursor);
    const body: { items: MailSummary[]; cursor?: string } = {
      items: page.items.map((m) => summary(decorate(m))),
    };
    if (page.cursor) body.cursor = page.cursor;
    return c.json(body);
  });

  r.get('/:id', async (c) => {
    const read = await readMail(deps.db, google!, c.req.param('id'), decorate);
    if (!read) return c.json({ error: 'Mail introuvable' }, 404);
    return c.json(read.detail);
  });

  r.get('/:id/attachments/:partId', async (c) => {
    const m = await fetchFull(google!, c.req.param('id'));
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

  const actionDeps = (): ActionDeps => ({ db: deps.db, google: google!, now: deps.clock });

  r.post('/batch', async (c) => {
    const parsed = BatchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const op = parsed.data.op as BatchOp;
    return guard(c, async () => {
      const changes = await batch(actionDeps(), parsed.data.ids, op);
      filed(parsed.data.ids, op);
      return changes;
    });
  });

  r.post('/send', async (c) => {
    const parsed = DraftBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return guard(c, () => sendMail(actionDeps(), stripUndefined(parsed.data)));
  });

  for (const [verb, schema] of Object.entries(SINGLE_OPS)) {
    r.post(`/:id/${verb}`, async (c) => {
      const parsed = schema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
      if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
      const op = parsed.data as BatchOp;
      return guard(c, async () => {
        const change = await applyOp(actionDeps(), c.req.param('id'), op);
        filed([c.req.param('id')], op);
        return change;
      });
    });
  }

  return r;
}

/** `GET /api/send-as[?replyTo=<id>]`: the "Send mail as" addresses and the one to use by default. */
export function sendAsRoutes(deps: AppDeps, google: GoogleClient | undefined): Hono {
  const r = new Hono();
  r.use('*', requireToken(deps.db));
  r.get('/', async (c) => {
    if (!google) return c.json({ error: 'Google n’est pas configuré sur ce serveur' }, 503);
    return c.json(await defaultFrom({ db: deps.db, google, now: deps.clock }, c.req.query('replyTo')));
  });
  return r;
}

const SINGLE_OPS = {
  file: z.object({ boxId: z.string().min(1) }).transform((b) => ({ kind: 'file' as const, ...b })),
  archive: z.object({}).transform(() => ({ kind: 'archive' as const })),
  trash: z.object({}).transform(() => ({ kind: 'trash' as const })),
  untrash: z.object({}).transform(() => ({ kind: 'untrash' as const })),
  spam: z.object({}).transform(() => ({ kind: 'spam' as const })),
  read: z.object({ read: z.boolean() }).transform((b) => ({ kind: 'read' as const, ...b })),
  tags: z
    .object({ add: z.array(z.string()).default([]), remove: z.array(z.string()).default([]) })
    .transform((b) => ({ kind: 'tags' as const, ...b })),
};

const OpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), boxId: z.string().min(1) }),
  z.object({ kind: z.literal('archive') }),
  z.object({ kind: z.literal('trash') }),
  z.object({ kind: z.literal('untrash') }),
  z.object({ kind: z.literal('spam') }),
  z.object({ kind: z.literal('read'), read: z.boolean() }),
  z.object({ kind: z.literal('tags'), add: z.array(z.string()), remove: z.array(z.string()) }),
]);

const BatchBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(500), op: OpSchema });

const DraftBody = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  cc: z.string().optional(),
  subject: z.string(),
  html: z.string(),
  text: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  threadId: z.string().optional(),
});

/** Maps the domain errors of an action to HTTP answers. */
async function guard(c: Context, run: () => Promise<unknown>) {
  try {
    return c.json((await run()) as object);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof BadRequestError) return c.json({ error: err.message }, 400);
    throw err;
  }
}
