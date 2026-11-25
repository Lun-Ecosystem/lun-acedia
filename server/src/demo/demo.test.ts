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

  it('writes a synthesis for each AI proposal, the fake code masked', async () => {
    const { db } = await createDemo();
    const row = db.prepare("SELECT synthesis FROM proposals WHERE message_id = 'm17'").get() as {
      synthesis: string;
    };
    expect(JSON.parse(row.synthesis)).toEqual([
      'Un inconnu promet un héritage, code [masqué] donné.',
      'Des coordonnées bancaires sont demandées.',
    ]);
    const missing = db
      .prepare("SELECT COUNT(*) AS n FROM proposals WHERE source = 'ai' AND synthesis IS NULL")
      .get();
    expect(missing).toEqual({ n: 0 });
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

describe('demo: the contract 1.5', () => {
  const demo = async () => {
    const d = await createDemo();
    const request = (method: string, path: string, body?: unknown) =>
      d.app.request(path, {
        method,
        headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const cards = async () =>
      ((await (await request('GET', '/lun/v1/cards')).json()) as { cards: { id: string }[] }).cards.map(
        (c) => c.id,
      );
    return { ...d, request, cards };
  };

  it('its classifier reaches the app by `classifier`: the digest makes the synthesis of a rule mail, no network', async () => {
    const d = await demo();
    const newsletters = (
      (await (await d.request('GET', '/api/labels')).json()) as { labels: { id: string; name: string }[] }
    ).labels.find((l) => l.name === 'Newsletters')!.id;
    const since = new Date(d.clock().getTime() - 30 * 86_400_000).toISOString();
    const until = new Date(d.clock().getTime() + 60_000).toISOString();
    const res = await d.request('POST', '/lun/v1/actions/day.digest', { since, until, boxes: [newsletters] });
    const { result } = (await res.json()) as { result: { received: { synthesis?: string }[] } };
    expect(result.received.length).toBeGreaterThan(0);
    for (const item of result.received) expect(item.synthesis).toBeTruthy();
    const digest = d.db.prepare("SELECT COUNT(*) AS n FROM costs WHERE purpose = 'digest'").get();
    expect(digest).toEqual({ n: result.received.length });
  });

  it('POST /api/demo/deliver brings the next mail: a new proposal in /cards, and a mail.changed', async () => {
    const d = await demo();
    const before = await d.cards();
    const lastEvent = (d.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id;
    const res = await d.request('POST', '/api/demo/deliver');
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const after = await d.cards();
    expect(after).toContain(`mail:${id}`);
    expect(after.filter((c) => !before.includes(c))).toEqual([`mail:${id}`]);
    // The pass's own signal (the sync's says `added`): the new proposal is in its `changed`.
    const changed = (
      d.db.prepare("SELECT data FROM events WHERE id > ? AND type = 'mail.changed'").all(lastEvent) as {
        data: string;
      }[]
    ).filter((e) => (JSON.parse(e.data) as { changed: string[] }).changed.includes(id));
    expect(changed).toHaveLength(1);
  });

  it('delivers each mail once, then says there is none left', async () => {
    const d = await demo();
    const ids: string[] = [];
    for (;;) {
      const res = await d.request('POST', '/api/demo/deliver');
      if (res.status !== 200) {
        expect(res.status).toBe(409);
        break;
      }
      ids.push(((await res.json()) as { id: string }).id);
    }
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the route is the demo’s own: a paired device only', async () => {
    const d = await demo();
    expect((await d.app.request('/api/demo/deliver', { method: 'POST' })).status).toBe(401);
  });
});
