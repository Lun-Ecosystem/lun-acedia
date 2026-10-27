import { describe, expect, it } from 'vitest';
import { makeHarness } from '../testing/harness.ts';
import { missingFromParity, PARITY, screenRoutes } from './parity.ts';

describe('screen and catalog parity', () => {
  it('every /api route of the app is in PARITY', () => {
    expect(missingFromParity(makeHarness().app)).toEqual([]);
  });

  it('every PARITY action exists in the catalog', () => {
    const names = new Set(
      makeHarness()
        .actions.list()
        .map((a) => a.name),
    );
    const actions = Object.values(PARITY).flatMap((p) => ('action' in p ? [p.action] : []));
    expect(actions.filter((a) => !names.has(a))).toEqual([]);
  });

  it('no PARITY entry points to a missing route', () => {
    const routes = new Set(screenRoutes(makeHarness().app));
    expect(Object.keys(PARITY).filter((k) => !routes.has(k))).toEqual([]);
  });

  it('every exclusion has a reason, and none of the actions sends', () => {
    for (const p of Object.values(PARITY)) expect('action' in p ? p.action : p.excluded).toMatch(/\S/);
    expect(
      Object.values(PARITY)
        .flatMap((p) => ('action' in p ? [p.action] : []))
        .join(),
    ).not.toMatch(/send/i);
  });

  it('a route added to the app without a PARITY entry is reported', () => {
    const app = makeHarness().app;
    app.get('/api/x', (c) => c.text('x'));
    expect(missingFromParity(app)).toEqual(['GET /api/x']);
  });
});
