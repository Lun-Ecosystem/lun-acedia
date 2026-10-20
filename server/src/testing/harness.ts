import { createApp, type AppDeps } from '../app.ts';
import { ActionRegistry } from '../contract/actions.ts';
import { issuePairingCode } from '../contract/auth.ts';
import { openDb } from '../db.ts';

/** A fresh app on an in-memory database, with a clock the test moves by hand. */
export function makeHarness(extra: Partial<Pick<AppDeps, 'google' | 'staticDir'>> = {}) {
  const db = openDb(':memory:');
  let now = new Date('2026-11-02T08:00:00.000Z');
  const clock = () => now;
  const actions = new ActionRegistry();
  const logs: string[] = [];
  const app = createApp({ db, clock, version: '0.0.0-test', actions, log: (l) => logs.push(l), ...extra });

  return {
    app,
    db,
    actions,
    clock,
    /** Warnings the app logged. */
    logs,
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
