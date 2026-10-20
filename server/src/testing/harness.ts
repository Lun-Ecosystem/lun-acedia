import { createApp, type AppDeps } from '../app.ts';
import { ActionRegistry } from '../contract/actions.ts';
import { issuePairingCode } from '../contract/auth.ts';
import { openDb } from '../db.ts';
import type { KeyCheck } from '../keys/anthropic-key.ts';

/** A fresh app on an in-memory database, with a clock the test moves by hand. */
export function makeHarness(
  extra: Partial<Pick<AppDeps, 'google' | 'staticDir' | 'secretKey' | 'anthropicEnv'>> = {},
) {
  const db = openDb(':memory:');
  let now = new Date('2026-11-02T08:00:00.000Z');
  const clock = () => now;
  const actions = new ActionRegistry();
  const logs: string[] = [];
  // Never the network: the Anthropic key check answers what the test sets.
  const anthropicCheck = { result: 'ok' as KeyCheck, calls: [] as string[] };
  const checkAnthropicKey = async (key: string) => {
    anthropicCheck.calls.push(key);
    return anthropicCheck.result;
  };
  const app = createApp({
    db,
    clock,
    version: '0.0.0-test',
    actions,
    log: (l) => logs.push(l),
    checkAnthropicKey,
    ...extra,
  });

  return {
    app,
    db,
    actions,
    clock,
    /** Warnings the app logged. */
    logs,
    /** What the fake Anthropic key check answers, and the keys it was given. */
    anthropicCheck,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    /** Pairs a client and returns its bearer token. */
    async pairClient(name = 'test'): Promise<string> {
      const code = issuePairingCode(db, now);
      const res = await app.request('/lun/v1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, client: name }),
      });
      const body = (await res.json()) as { token: string };
      return body.token;
    },
    auth(token: string): Record<string, string> {
      return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    },
  };
}
