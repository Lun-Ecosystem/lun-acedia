import { describe, expect, it } from 'vitest';
import { makeHarness } from '../testing/harness.ts';
import { putSetting } from '../db.ts';
import { getState } from './state.ts';

describe('POST /lun/v1/pause and /resume', () => {
  it('pauses once, then answers 409', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const pause = () =>
      h.app.request('/lun/v1/pause', { method: 'POST', headers: h.auth(token), body: '{"reason":"test"}' });
    const first = await pause();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'paused' });
    expect(getState(h.db).paused).toBe(true);
    const second = await pause();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: expect.any(String) });
  });

  it('refuses to resume when already active', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const res = await h.app.request('/lun/v1/resume', { method: 'POST', headers: h.auth(token) });
    expect(res.status).toBe(409);
  });

  it('resumes after a pause', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    await h.app.request('/lun/v1/pause', { method: 'POST', headers: h.auth(token) });
    const res = await h.app.request('/lun/v1/resume', { method: 'POST', headers: h.auth(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(getState(h.db).paused).toBe(false);
  });

  const post = (h: ReturnType<typeof makeHarness>, token: string, path: string, body: unknown) =>
    h.app.request(`/lun/v1/${path}`, { method: 'POST', headers: h.auth(token), body: JSON.stringify(body) });

  it('keeps the core pause and the local pause apart', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    expect((await post(h, token, 'pause', { by: 'core' })).status).toBe(200);
    expect(getState(h.db)).toMatchObject({ core: true, local: false, pausedBy: 'core' });
    expect((await post(h, token, 'pause', {})).status).toBe(200);
    expect(getState(h.db)).toMatchObject({ core: true, local: true, pausedBy: 'local' });
    const res = await post(h, token, 'resume', { by: 'core' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'paused' });
    expect(getState(h.db)).toMatchObject({ core: false, local: true, pausedBy: 'local' });
    const last = await post(h, token, 'resume', {});
    expect(last.status).toBe(200);
    expect(await last.json()).toEqual({ status: 'ok' });
  });

  it('answers 409 to a pause or a resume of the same origin twice', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    expect((await post(h, token, 'pause', { by: 'core' })).status).toBe(200);
    expect((await post(h, token, 'pause', { by: 'core' })).status).toBe(409);
    await post(h, token, 'resume', { by: 'core' });
    await post(h, token, 'pause', {});
    expect((await post(h, token, 'resume', { by: 'core' })).status).toBe(409);
    expect((await post(h, token, 'pause', {})).status).toBe(409);
    await post(h, token, 'resume', {});
    expect((await post(h, token, 'resume', {})).status).toBe(409);
  });

  it('does not let a local resume lift a core pause', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    await post(h, token, 'pause', { by: 'core' });
    expect((await post(h, token, 'resume', {})).status).toBe(409);
    expect(getState(h.db)).toMatchObject({ core: true, local: false });
  });

  it('reads a pause stored before v1.4 as local', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    putSetting(h.db, 'paused', true);
    expect(getState(h.db)).toMatchObject({ local: true, core: false, pausedBy: 'local' });
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(await res.json()).toMatchObject({ status: 'paused', pausedBy: 'local' });
  });

  it('refuses an unknown origin', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const res = await post(h, token, 'pause', { by: 'satellite' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});
