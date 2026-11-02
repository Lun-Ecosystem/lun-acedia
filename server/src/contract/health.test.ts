import { describe, expect, it } from 'vitest';
import { makeHarness } from '../testing/harness.ts';
import { putPinaSettings } from '../pina/store.ts';
import { addDegraded, clearDegraded, setPaused } from './state.ts';

describe('GET /lun/v1/health', () => {
  it('reports ok with the version', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.0-test', contract: '1.4', agent: true });
  });

  it('reports paused', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    setPaused(h.db, true);
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect((await res.json()).status).toBe('paused');
  });

  it('reports degraded with its reason, over paused, and still tells the pause', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    setPaused(h.db, true);
    addDegraded(h.db, 'credit');
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(await res.json()).toEqual({
      status: 'degraded',
      reason: 'credit',
      paused: true,
      pausedBy: 'local',
      version: '0.0.0-test',
      contract: '1.4',
      agent: true,
    });
  });

  it('keeps several reasons and clears them one by one', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    addDegraded(h.db, 'credit');
    addDegraded(h.db, 'google-reauth');
    clearDegraded(h.db, 'credit');
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(await res.json()).toEqual({
      status: 'degraded',
      reason: 'google-reauth',
      version: '0.0.0-test',
      contract: '1.4',
      agent: true,
    });
    clearDegraded(h.db, 'google-reauth');
    const after = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect((await after.json()).status).toBe('ok');
  });

  it('says who paused', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const get = async () => (await h.app.request('/lun/v1/health', { headers: h.auth(token) })).json();
    setPaused(h.db, true, 'core');
    expect(await get()).toMatchObject({ status: 'paused', pausedBy: 'core' });
    setPaused(h.db, true);
    expect(await get()).toMatchObject({ pausedBy: 'local' });
  });

  it('declares the agent name only once the user set one', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const get = async () => (await h.app.request('/lun/v1/health', { headers: h.auth(token) })).json();
    expect(await get()).not.toHaveProperty('agentName');
    putPinaSettings(h.db, { name: 'Iris' });
    expect(await get()).toMatchObject({ agentName: 'Iris' });
  });
});
