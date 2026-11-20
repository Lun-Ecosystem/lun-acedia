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
    expect((await get('/api/llm/providers')).providers[0]).toMatchObject({
      id: 'anthropic',
      state: 'ok',
      last4: 'ZQAA',
    });
    const pina = await get('/api/pina/today');
    // The cards of the overlap detection are checked on their own below.
    const seeded = pina.cards.filter((c: { callId: string }) => !c.callId.startsWith('chevauchement:'));
    expect(seeded.map((c: { status: string }) => c.status)).toEqual(['done', 'done', 'pending', 'pending']);
    expect(seeded[2]).toMatchObject({ action: 'event.delete', effect: 'delete' });
    expect(pina.pending).toBe(2 + pina.cards.length - seeded.length);
    expect((await get('/api/journal')).items.some((e: { origin: string }) => e.origin === 'pina')).toBe(true);
    expect((await app.request('/api/mail')).status).toBe(401);
  });

  it('shows the two cards of conflict: one that proposes a move, one that only signals', async () => {
    const { app, token } = await createDemo();
    const res = await app.request('/api/pina/today', { headers: { authorization: `Bearer ${token}` } });
    const cards = (
      (await res.json()) as { cards: { callId: string; action: string; status: string }[] }
    ).cards.filter((c) => c.callId.startsWith('chevauchement:'));
    expect(cards.map((c) => c.action).sort()).toEqual(['agenda.list', 'event.update']);
    expect(cards.every((c) => c.status === 'pending')).toBe(true);
  });
});
