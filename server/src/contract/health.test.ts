import { describe, expect, it } from 'vitest';
import { makeHarness } from '../testing/harness.ts';
import { addDegraded, clearDegraded, setPaused } from './state.ts';

describe('GET /lun/v1/health', () => {
  it('reports ok with the version', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.0-test' });
  });

  it('reports paused', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    setPaused(h.db, true);
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect((await res.json()).status).toBe('paused');
  });

  it('reports degraded with its reason, over paused', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    setPaused(h.db, true);
    addDegraded(h.db, 'credit');
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(await res.json()).toEqual({ status: 'degraded', reason: 'credit', version: '0.0.0-test' });
  });

  it('keeps several reasons and clears them one by one', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    addDegraded(h.db, 'credit');
    addDegraded(h.db, 'google-reauth');
    clearDegraded(h.db, 'credit');
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(await res.json()).toEqual({ status: 'degraded', reason: 'google-reauth', version: '0.0.0-test' });
    clearDegraded(h.db, 'google-reauth');
    const after = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect((await after.json()).status).toBe('ok');
  });
});
