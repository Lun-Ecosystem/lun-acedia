import { describe, expect, it } from 'vitest';
import { createDemo } from './demo.ts';

describe('demo', () => {
  it('serves the seeded mail, proposals, journal and agenda to the paired device', async () => {
    const { app, token } = await createDemo();
    const get = async (path: string) =>
      (await app.request(path, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get('/api/mail')).items.length).toBeGreaterThan(5);
    const pending = await get('/api/mail?view=pending');
    expect(pending.items.length).toBe(6);
    expect(pending.items[0].proposal.reason).toBeTruthy();
    expect((await get('/api/journal')).items.length).toBeGreaterThan(4);
    expect((await get('/api/settings')).threshold).toBe(95);
    expect((await get('/api/calendars')).items.length).toBe(3);
    expect((await get('/api/rules')).rules.length).toBe(2);
    expect((await get('/api/clients')).clients.length).toBe(2);
    expect(await get('/api/anthropic-key')).toMatchObject({ state: 'ok', last4: 'ZQAA' });
    expect((await app.request('/api/mail')).status).toBe(401);
  });
});
