import { describe, expect, it } from 'vitest';
import { makeHarness } from '../testing/harness.ts';
import { bootstrapPairing, issuePairingCode, revokeClient } from './auth.ts';

const json = { 'content-type': 'application/json' };

describe('POST /lun/v1/pair', () => {
  it('exchanges a valid code for a token and the satellite identity', async () => {
    const h = makeHarness();
    const code = issuePairingCode(h.db, h.clock());
    const res = await h.app.request('/lun/v1/pair', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ code, client: 'core' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/.{32,}/);
    expect(body.satellite).toEqual({ id: 'lunacedia', nom: "Lun'Acedia", version: '0.0.0-test' });
  });

  it('refuses a code used twice', async () => {
    const h = makeHarness();
    const code = issuePairingCode(h.db, h.clock());
    const pair = () =>
      h.app.request('/lun/v1/pair', { method: 'POST', headers: json, body: JSON.stringify({ code }) });
    expect((await pair()).status).toBe(200);
    const second = await pair();
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: 'Code d’appairage invalide, déjà utilisé ou expiré' });
  });

  it('refuses a code older than 10 minutes', async () => {
    const h = makeHarness();
    const code = issuePairingCode(h.db, h.clock());
    h.advance(10 * 60_000 + 1_000);
    const res = await h.app.request('/lun/v1/pair', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(401);
  });

  it('issues six-digit codes', () => {
    const h = makeHarness();
    expect(issuePairingCode(h.db, h.clock())).toMatch(/^\d{6}$/);
  });
});

describe('bearer token', () => {
  it('rejects a request without a token', async () => {
    const h = makeHarness();
    const res = await h.app.request('/lun/v1/health');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('rejects a revoked token', async () => {
    const h = makeHarness();
    const token = await h.pairClient('phone');
    const clients = h.db.prepare('SELECT id FROM clients').all() as { id: number }[];
    revokeClient(h.db, clients[0]!.id);
    const res = await h.app.request('/lun/v1/health', { headers: h.auth(token) });
    expect(res.status).toBe(401);
  });

  it('stores tokens hashed, never in clear', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const rows = h.db.prepare('SELECT * FROM clients').all();
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('first device pairing', () => {
  it('logs a code when no client is paired yet', () => {
    const h = makeHarness();
    const lines: string[] = [];
    bootstrapPairing(h.db, h.clock(), (l) => lines.push(l));
    expect(lines.join('\n')).toMatch(/\d{6}/);
  });

  it('logs nothing once a client exists', async () => {
    const h = makeHarness();
    await h.pairClient();
    const lines: string[] = [];
    bootstrapPairing(h.db, h.clock(), (l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  it('lets a paired client create a new code from the front', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const res = await h.app.request('/api/pairing-codes', { method: 'POST', headers: h.auth(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.expiresAt).toBe('2026-11-02T08:10:00.000Z');
  });
});
