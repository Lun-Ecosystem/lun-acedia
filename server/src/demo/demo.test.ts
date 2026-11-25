import { describe, expect, it } from 'vitest';
import { createDemo } from './demo.ts';

describe('demo', () => {
  it('serves the seeded mail, proposals, journal and agenda to the paired device', async () => {
    const { app, token } = await createDemo();
    const get = async (path: string) =>
      (await app.request(path, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get('/api/mail')).items.length).toBeGreaterThan(5);
    const pending = await get('/api/mail?view=pending');
    expect(pending.items.map((m: { id: string }) => m.id).sort()).toEqual(['m02', 'm03', 'm06', 'm11']);
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

  it('shows in the journal a validation, a correction, a trash by hand and an undone line', async () => {
    const { app, token, db } = await createDemo();
    const get = async (path: string) =>
      (await app.request(path, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    type Line = {
      messageId: string;
      origin: string;
      action: string;
      before: string[];
      after: string[];
      undoneAt: string | null;
    };
    const lines = (await get('/api/journal')).items as Line[];
    const of = (id: string) => lines.filter((l) => l.messageId === id);
    const factures = (await get('/api/labels')).labels.find(
      (l: { name: string }) => l.name === 'Factures',
    ).id;
    expect(of('m01')).toEqual([
      expect.objectContaining({ origin: 'user', action: 'validate', before: ['INBOX', 'UNREAD'] }),
    ]);
    expect(of('m01')[0]!.after).toContain(factures);
    expect(of('m01')[0]!.after).not.toContain('INBOX');
    expect(of('m17')).toEqual([
      expect.objectContaining({ origin: 'user', action: 'validate', before: ['INBOX', 'UNREAD'] }),
    ]);
    expect(of('m17')[0]!.after).toContain('SPAM');
    expect(of('m15')).toEqual([
      expect.objectContaining({ origin: 'user', action: 'correct', before: ['INBOX'] }),
    ]);
    expect(of('m15')[0]!.after).toContain('TRASH');
    expect(of('m16')).toEqual([
      expect.objectContaining({ origin: 'user', action: 'trash', before: ['INBOX', 'UNREAD'] }),
    ]);
    expect(of('m16')[0]!.after).toContain('TRASH');
    expect(of('m08')).toEqual([
      expect.objectContaining({ origin: 'rule', action: 'file', undoneAt: expect.any(String) }),
    ]);
    expect(of('m18')).toEqual([
      expect.objectContaining({
        origin: 'user',
        action: 'refuse',
        before: expect.arrayContaining(['INBOX']),
      }),
    ]);
    expect(of('m18')[0]!.after).toEqual(of('m18')[0]!.before);
    const ids = async (view: string) =>
      ((await get(`/api/mail?view=${view}`)).items as { id: string }[]).map((m) => m.id);
    expect(await ids('pending')).not.toContain('m18');
    expect((await ids('pending')).sort()).toEqual(['m02', 'm03', 'm06', 'm11']);
    expect(await ids('inbox')).not.toContain('m15');
    expect(await ids('inbox')).not.toContain('m16');
    expect(await ids('trash')).toEqual(expect.arrayContaining(['m15', 'm16']));
    // The scenarios of the agent's evaluation start from these: still in the inbox.
    const labels = (id: string) =>
      (db.prepare('SELECT label_ids FROM messages WHERE id = ?').get(id) as { label_ids: string }).label_ids;
    for (const id of ['m02', 'm03', 'm11']) expect(labels(id)).toContain('INBOX');
  });

  it('leaves the evaluation (`pina: false`) without the journal gestures, its inbox as before', async () => {
    const { db } = await createDemo({ pina: false });
    const inbox = (
      db.prepare('SELECT id FROM messages WHERE label_ids LIKE \'%"INBOX"%\' ORDER BY id').all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    expect(inbox).toEqual(['m01', 'm02', 'm03', 'm06', 'm11', 'm15']);
    const actions = (db.prepare('SELECT action FROM journal').all() as { action: string }[]).map(
      (r) => r.action,
    );
    expect(actions).not.toContain('validate');
    expect(actions).not.toContain('correct');
    expect(actions).not.toContain('trash');
    expect(actions).not.toContain('refuse');
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

  describe('the Google account', () => {
    const status = async (opts?: Parameters<typeof createDemo>[0]) => {
      const { app, token } = await createDemo(opts);
      const res = await app.request('/api/google/status', { headers: { authorization: `Bearer ${token}` } });
      return { code: res.status, body: await res.json() };
    };

    it('is connected by default', async () => {
      expect(await status()).toEqual({ code: 200, body: { connected: true } });
    });

    it('is unreadable on demand (DEMO_GOOGLE=unreadable)', async () => {
      const opts = { googleUnreadable: true };
      expect(await status(opts)).toEqual({ code: 200, body: { connected: false, unreadable: true } });
    });
  });
});
