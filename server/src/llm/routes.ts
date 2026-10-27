import type { Context } from 'hono';
import { Hono } from 'hono';
import OpenAI from 'openai';
import type { AppDeps } from '../app.ts';
import { checkExpiry, isValidDate } from '../keys/expiry.ts';
import {
  checkWithProvider,
  choiceFor,
  configuredProviders,
  credentials,
  keyWorks,
  LABELS,
  PROVIDERS,
  providersView,
  providerView,
  removeKey,
  saveChoice,
  saveKey,
  type ProviderView,
} from './keys.ts';
import type { ModelOffer } from '../types.ts';
import { modelsFor, tierOf } from './models.ts';
import type { ProviderId } from './types.ts';

/** Lists the models of the custom endpoint. */
export type ModelLister = (apiKey: string, baseUrl: string) => Promise<string[]>;

export const listWithModelsApi: ModelLister = async (apiKey, baseURL) => {
  const page = await new OpenAI({ apiKey, baseURL, maxRetries: 1, timeout: 15_000 }).models.list();
  return page.data.map((m) => m.id);
};

const USES = ['triage', 'pina'] as const;
type Use = (typeof USES)[number];
const isUse = (v: unknown): v is Use => USES.includes(v as Use);
const isProvider = (v: unknown): v is ProviderId => PROVIDERS.includes(v as ProviderId);

/** An http(s) address without credentials: they would be stored and shown in clear. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks then saves a key (`{ key, expires?, baseUrl? }`): the view of the provider, or the error answer.
 * The key is never logged nor sent back: the view carries its last 4 characters at most.
 */
async function putKey(deps: AppDeps, id: ProviderId, c: Context): Promise<ProviderView | Response> {
  if (!deps.secretKey)
    return c.json({ error: 'ACEDIA_SECRET_KEY absente : la clé ne peut pas être enregistrée' }, 400);
  const body = await jsonBody(c);
  if (!body) return c.json({ error: 'Corps JSON invalide' }, 400);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return c.json({ error: 'Clé attendue' }, 400);
  // No date (absent, null or empty) is fine; anything else must be a real AAAA-MM-JJ.
  const rawExpires = body.expires ?? '';
  const expires = typeof rawExpires === 'string' ? rawExpires.trim() || undefined : '';
  if (expires !== undefined && !isValidDate(expires))
    return c.json({ error: 'Date d’échéance attendue au format AAAA-MM-JJ' }, 400);
  const baseUrl = id === 'custom' && typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined;
  if (id === 'custom' && !(baseUrl && isHttpUrl(baseUrl)))
    return c.json({ error: 'Adresse attendue, en http:// ou https://, sans identifiants' }, 400);
  const label = LABELS[id];
  const check = await (deps.checkKey ?? checkWithProvider)(id, key, baseUrl);
  if (check === 'refused') return c.json({ error: `Clé refusée par ${label}, rien n’a changé` }, 400);
  if (check === 'unreachable') return c.json({ error: `${label} injoignable, rien n’a changé` }, 502);
  saveKey(deps.db, deps.secretKey, id, key, expires, baseUrl);
  keyWorks(deps.db, id, deps.clock());
  checkExpiry(deps.db, deps.clock(), expires, `Clé ${label}`, id);
  return providerView(deps.db, deps.secretKey, deps.llmEnv ?? {}, id);
}

/** The models offered for a use: the table's for the configured providers, the custom endpoint's own. */
async function modelsOffered(deps: AppDeps, use: Use): Promise<ModelOffer[]> {
  const env = deps.llmEnv ?? {};
  const configured = configuredProviders(deps.db, deps.secretKey, env);
  const models = modelsFor(deps.db, use, configured);
  const custom = credentials(deps.db, deps.secretKey, env, 'custom');
  if (custom?.baseUrl) {
    try {
      const ids = await (deps.listCustomModels ?? listWithModelsApi)(custom.key, custom.baseUrl);
      // shortcut: the endpoint says nothing of tool calling, assumed for every model; filter once Pina meets one without.
      models.push(...ids.map((id) => ({ provider: 'custom' as const, id, label: id, tools: true })));
    } catch {
      // The endpoint does not answer: only the table models are offered.
    }
  }
  return models.map((m) => ({ ...m, tier: tierOf(m) }));
}

export function llmRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const env = () => deps.llmEnv ?? {};

  r.get('/providers', (c) => c.json({ providers: providersView(deps.db, deps.secretKey, env()) }));
  r.put('/providers/:id/key', async (c) => {
    const id = c.req.param('id');
    if (!isProvider(id)) return c.json({ error: 'Fournisseur inconnu' }, 404);
    const res = await putKey(deps, id, c);
    return res instanceof Response ? res : c.json(res);
  });
  r.delete('/providers/:id/key', (c) => {
    const id = c.req.param('id');
    if (!isProvider(id)) return c.json({ error: 'Fournisseur inconnu' }, 404);
    removeKey(deps.db, id);
    return c.json(providerView(deps.db, deps.secretKey, env(), id));
  });
  r.get('/models', async (c) => {
    const use = c.req.query('use');
    if (!isUse(use)) return c.json({ error: "use attendu : 'triage' ou 'pina'" }, 400);
    return c.json({ models: await modelsOffered(deps, use) });
  });
  r.get('/choice', (c) =>
    c.json({
      triage: choiceFor(deps.db, deps.secretKey, env(), 'triage'),
      pina: choiceFor(deps.db, deps.secretKey, env(), 'pina'),
    }),
  );
  r.put('/choice', async (c) => {
    const body = await jsonBody(c);
    if (!body) return c.json({ error: 'Corps JSON invalide' }, 400);
    const { use, provider, model } = body;
    if (!isUse(use)) return c.json({ error: "use attendu : 'triage' ou 'pina'" }, 400);
    const offered = await modelsOffered(deps, use);
    if (!offered.some((m) => m.provider === provider && m.id === model))
      return c.json({ error: 'Modèle non disponible pour cet usage' }, 400);
    const choice = { provider: provider as ProviderId, model: model as string };
    saveChoice(deps.db, use, choice);
    return c.json(choice);
  });
  return r;
}
