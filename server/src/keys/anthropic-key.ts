import type { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
import { emitEvent } from '../contract/events.ts';
import { addDegraded, clearDegraded, getState } from '../contract/state.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { getSetting, putSetting } from '../db.ts';
import { createAnthropicProvider, isKeyRefusedError } from '../llm/anthropic.ts';
import { createLlmClassifier, DEFAULT_MODEL } from '../triage/llm-classifier.ts';
import type { Classifier } from '../triage/classifier.ts';
import { isValidDate, WARNED } from './expiry.ts';

/** How the key is named in the expiry warnings. */
export const ANTHROPIC_LABEL = 'Clé Anthropic';
/** The degraded reason, same convention as `credit` and `google-reauth`. */
export const KEY_REASON = 'anthropic-key';

const KEY = 'anthropic.key';
const EXPIRES = 'anthropic.expires';
/** `refused` from the first refusal until a call works again; kept across restarts. */
const STATE = 'anthropic.keyState';
const isRefused = (db: DatabaseSync) => getSetting<'ok' | 'refused'>(db, STATE, 'ok') === 'refused';

export type KeyCheck = 'ok' | 'refused' | 'unreachable';
/** Tries a key without spending anything. */
export type KeyChecker = (apiKey: string) => Promise<KeyCheck>;

/** What `.env` declares: `ANTHROPIC_API_KEY` and `ANTHROPIC_KEY_EXPIRES`. */
export interface AnthropicEnv {
  key?: string | undefined;
  expires?: string | undefined;
}

export interface AnthropicKeyView {
  state: 'ok' | 'refused' | 'credit' | 'absent';
  last4?: string;
  expires?: string;
  source?: 'saved' | 'env';
}

/** The real check: listing the models is free; 401 or 403 means the key is refused. */
export const checkWithModelsList: KeyChecker = async (apiKey) => {
  try {
    await new Anthropic({ apiKey, maxRetries: 1, timeout: 15_000 }).models.list({ limit: 1 });
    return 'ok';
  } catch (err) {
    return isKeyRefusedError(err) ? 'refused' : 'unreachable';
  }
};

/** The key in service: the saved one wins over `.env` until it is replaced. */
export function currentAnthropicKey(
  db: DatabaseSync,
  secretKey: string | undefined,
  envKey?: string,
): { key: string; source: 'saved' | 'env' } | undefined {
  const blob = getSetting<string | null>(db, KEY, null);
  if (blob && secretKey) {
    try {
      return { key: decrypt(blob, secretKey), source: 'saved' };
    } catch {
      // Unreadable with this ACEDIA_SECRET_KEY: the `.env` key, if any, takes over.
    }
  }
  return envKey ? { key: envKey, source: 'env' } : undefined;
}

/** Saves a checked key, encrypted, with its declared expiry; the expiry warnings start over. */
export function saveAnthropicKey(db: DatabaseSync, secretKey: string, key: string, expires?: string): void {
  putSetting(db, KEY, encrypt(key, secretKey));
  putSetting(db, EXPIRES, expires ?? null);
  putSetting(db, WARNED, []);
}

/** Forgets the saved key and its expiry; without a key nothing is refused any more. */
export function removeAnthropicKey(db: DatabaseSync): void {
  putSetting(db, KEY, null);
  putSetting(db, EXPIRES, null);
  putSetting(db, WARNED, []);
  putSetting(db, STATE, 'ok');
  clearDegraded(db, KEY_REASON);
}

/** The declared expiry of the key in service. */
export function currentExpiry(
  db: DatabaseSync,
  secretKey: string | undefined,
  env: AnthropicEnv,
): string | undefined {
  const current = currentAnthropicKey(db, secretKey, env.key);
  if (!current) return undefined;
  const expires = current.source === 'saved' ? getSetting<string | null>(db, EXPIRES, null) : env.expires;
  return expires && isValidDate(expires) ? expires : undefined;
}

/** Anthropic refused the key: AI triage pauses (the rules go on); one `key.invalid` per change. */
export function keyRefused(db: DatabaseSync, now: Date): void {
  addDegraded(db, KEY_REASON);
  if (isRefused(db)) return;
  putSetting(db, STATE, 'refused');
  emitEvent(
    db,
    {
      type: 'key.invalid',
      importance: 'normal',
      title: 'Clé Anthropic refusée : le tri par l’IA est en pause, les règles continuent',
    },
    now,
  );
}

/** A call went through (or a new key was checked): back in service after a refusal. */
export function keyWorks(db: DatabaseSync, now: Date): void {
  if (!isRefused(db)) return;
  putSetting(db, STATE, 'ok');
  clearDegraded(db, KEY_REASON);
  emitEvent(
    db,
    { type: 'key.restored', importance: 'info', title: 'Clé Anthropic de nouveau en service' },
    now,
  );
}

/** What the settings screen shows; never more of the key than its last 4 characters. */
export function anthropicKeyView(
  db: DatabaseSync,
  secretKey: string | undefined,
  env: AnthropicEnv,
): AnthropicKeyView {
  const current = currentAnthropicKey(db, secretKey, env.key);
  if (!current) return { state: 'absent' };
  const state = isRefused(db) ? 'refused' : getState(db).degraded.includes('credit') ? 'credit' : 'ok';
  const expires = currentExpiry(db, secretKey, env);
  return {
    state,
    last4: current.key.slice(-4),
    ...(expires ? { expires } : {}),
    source: current.source,
  };
}

type MakeClassifier = (apiKey: string) => Classifier;
const makeAnthropic: MakeClassifier = (apiKey) =>
  createLlmClassifier({ provider: createAnthropicProvider({ apiKey }), model: DEFAULT_MODEL });
const built = new WeakMap<MakeClassifier, { key: string; classifier: Classifier }>();

/**
 * The classifier for the key in service, looked up at each triage pass: a saved key serves from the
 * next mail on, without a restart. `undefined` without any key (only the rules run).
 */
export function classifierFor(
  db: DatabaseSync,
  secretKey: string | undefined,
  envKey?: string,
  make: MakeClassifier = makeAnthropic,
): Classifier | undefined {
  const current = currentAnthropicKey(db, secretKey, envKey);
  if (!current) return undefined;
  const cached = built.get(make);
  if (cached?.key === current.key) return cached.classifier;
  const classifier = make(current.key);
  built.set(make, { key: current.key, classifier });
  return classifier;
}
