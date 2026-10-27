import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { stripUndefined } from '../util.ts';
import { requireToken } from '../contract/auth.ts';
import { BadRequestError, NotFoundError, type ActionDeps } from '../gmail/actions.ts';
import type { GoogleClient } from '../google/client.ts';
import { ConflictError, listJournal, todayStats, undo } from './journal.ts';
import { createLabel, listLabels, setRole } from './labels.ts';
import { getSetting, putSetting } from '../db.ts';
import { correct, DEFAULT_BULK_THRESHOLD, DEFAULT_THRESHOLD, validate } from './pipeline.ts';
import { createRule, deleteRule, listRules, updateRule } from './rules.ts';

export const RoleSchema = z.enum(['box', 'tag']);
export const RuleSchema = z.object({
  field: z.enum(['from', 'fromDomain', 'to', 'subject']),
  op: z.enum(['equals', 'contains']),
  value: z.string().trim().min(1),
  boxId: z.string().min(1),
  tagIds: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

/** Maps the domain errors to HTTP answers. */
export async function answer(c: Context, run: () => unknown) {
  try {
    return c.json((await run()) as object);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof BadRequestError) return c.json({ error: err.message }, 400);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    throw err;
  }
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : c.json({ error: parsed.error.message }, 400);
}

const settings = (deps: AppDeps) => {
  const threshold = getSetting(deps.db, 'threshold', DEFAULT_THRESHOLD);
  const bulkThreshold = getSetting(deps.db, 'bulkThreshold', DEFAULT_BULK_THRESHOLD);
  return { threshold, bulkThreshold: Math.min(bulkThreshold, threshold) };
};

/** `/api/labels`, `/api/rules`, `/api/journal`, `/api/settings` and the answers to the AI's proposals. */
export function triageRoutes(deps: AppDeps, google: GoogleClient | undefined): Hono {
  const r = new Hono();
  r.use('*', requireToken(deps.db));
  const actionDeps = (): ActionDeps => {
    if (!google) throw new BadRequestError('Google n’est pas configuré sur ce serveur');
    return { db: deps.db, google, now: deps.clock };
  };

  r.get('/labels', (c) => c.json({ labels: listLabels(deps.db) }));
  r.post('/labels', async (c) => {
    const input = await body(c, z.object({ name: z.string().trim().min(1), role: RoleSchema }));
    if (input instanceof Response) return input;
    return answer(c, () => createLabel(actionDeps(), input.name, input.role));
  });
  r.patch('/labels/:id', async (c) => {
    const input = await body(c, z.object({ role: RoleSchema.nullable() }));
    if (input instanceof Response) return input;
    return answer(c, () => {
      setRole(deps.db, c.req.param('id'), input.role);
      return listLabels(deps.db).find((l) => l.id === c.req.param('id'));
    });
  });

  r.get('/rules', (c) => c.json({ rules: listRules(deps.db) }));
  r.post('/rules', async (c) => {
    const input = await body(c, RuleSchema);
    if (input instanceof Response) return input;
    return answer(c, () => createRule(deps.db, stripUndefined(input)));
  });
  r.patch('/rules/:id', async (c) => {
    const input = await body(c, RuleSchema.partial().extend({ position: z.number().int().optional() }));
    if (input instanceof Response) return input;
    return answer(c, () => updateRule(deps.db, Number(c.req.param('id')), stripUndefined(input)));
  });
  r.delete('/rules/:id', (c) => {
    deleteRule(deps.db, Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  r.get('/journal', (c) => {
    const cursor = c.req.query('cursor');
    return c.json(listJournal(deps.db, cursor ? Number(cursor) : undefined));
  });
  r.post('/journal/:id/undo', (c) => answer(c, () => undo(actionDeps(), Number(c.req.param('id')))));

  r.get('/stats/today', (c) => c.json(todayStats(deps.db, deps.clock())));

  r.post('/mail/:id/validate', (c) => answer(c, () => validate(actionDeps(), c.req.param('id'))));
  r.post('/mail/:id/correct', async (c) => {
    const input = await body(
      c,
      z.object({
        boxId: z.string().min(1),
        tagIds: z.array(z.string()).default([]),
        rememberSender: z.boolean().optional(),
      }),
    );
    if (input instanceof Response) return input;
    return answer(c, () =>
      correct(
        actionDeps(),
        c.req.param('id'),
        input.boxId,
        input.tagIds,
        stripUndefined({ rememberSender: input.rememberSender }),
      ),
    );
  });

  r.get('/settings', (c) => c.json(settings(deps)));
  r.put('/settings', async (c) => {
    const percent = z.number().int().min(0).max(100);
    const input = await body(
      c,
      z.object({ threshold: percent.optional(), bulkThreshold: percent.optional() }),
    );
    if (input instanceof Response) return input;
    const current = settings(deps);
    const threshold = input.threshold ?? current.threshold;
    if (input.bulkThreshold !== undefined && input.bulkThreshold > threshold)
      return c.json(
        { error: 'Le seuil de « Tout valider » ne peut pas dépasser le seuil d’auto-rangement' },
        400,
      );
    // Lowering the threshold below the bulk threshold drags it down.
    const bulkThreshold = Math.min(input.bulkThreshold ?? current.bulkThreshold, threshold);
    putSetting(deps.db, 'threshold', threshold);
    putSetting(deps.db, 'bulkThreshold', bulkThreshold);
    return c.json(settings(deps));
  });

  return r;
}
