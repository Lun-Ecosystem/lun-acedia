import { describe, expect, it } from 'vitest';
import { makeHarness } from './testing/harness.ts';

describe('/api/clients', () => {
  it('lists and revokes clients, current flagged, no hash in the response', async () => {
    const h = makeHarness();
    const mine = await h.pairClient('laptop');
    const other = await h.pairClient('phone');

    const res = await h.app.request('/api/clients', { headers: h.auth(mine) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/hash/i);
    const { clients } = JSON.parse(text) as { clients: { id: number; current: boolean }[] };
    expect(clients).toEqual([
      {
        id: expect.any(Number),
        name: 'laptop',
        kind: 'device',
        createdAt: '2026-11-02T08:00:00.000Z',
        current: true,
      },
      {
        id: expect.any(Number),
        name: 'phone',
        kind: 'device',
        createdAt: '2026-11-02T08:00:00.000Z',
        current: false,
      },
    ]);

    const del = await h.app.request(`/api/clients/${clients[1]!.id}`, {
      method: 'DELETE',
      headers: h.auth(mine),
    });
    expect(del.status).toBe(204);
    expect((await h.app.request('/lun/v1/health', { headers: h.auth(other) })).status).toBe(401);
    const after = (await (await h.app.request('/api/clients', { headers: h.auth(mine) })).json()) as {
      clients: unknown[];
    };
    expect(after.clients).toHaveLength(1);
    // Soft revocation: the row stays.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM clients').get()).toEqual({ n: 2 });

    expect(
      (await h.app.request(`/api/clients/${clients[1]!.id}`, { method: 'DELETE', headers: h.auth(mine) }))
        .status,
    ).toBe(404);
    expect(
      (await h.app.request('/api/clients/9999', { method: 'DELETE', headers: h.auth(mine) })).status,
    ).toBe(404);
    expect(
      (await h.app.request('/api/clients/abc', { method: 'DELETE', headers: h.auth(mine) })).status,
    ).toBe(404);
  });

  it('lets the current device revoke itself', async () => {
    const h = makeHarness();
    const mine = await h.pairClient('laptop');
    const { clients } = (await (await h.app.request('/api/clients', { headers: h.auth(mine) })).json()) as {
      clients: { id: number }[];
    };
    const del = await h.app.request(`/api/clients/${clients[0]!.id}`, {
      method: 'DELETE',
      headers: h.auth(mine),
    });
    expect(del.status).toBe(204);
    expect((await h.app.request('/api/clients', { headers: h.auth(mine) })).status).toBe(401);
  });
});
