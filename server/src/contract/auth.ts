import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MiddlewareHandler } from 'hono';

const CODE_TTL_MS = 10 * 60_000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A one-time six-digit code, valid for 10 minutes. */
export function issuePairingCode(db: DatabaseSync, now: Date): string {
  let code: string;
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (db.prepare('SELECT 1 FROM pairing_codes WHERE code = ?').get(code));
  db.prepare('INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)').run(
    code,
    new Date(now.getTime() + CODE_TTL_MS).toISOString(),
  );
  return code;
}

export function codeExpiry(db: DatabaseSync, code: string): string | undefined {
  const row = db.prepare('SELECT expires_at FROM pairing_codes WHERE code = ?').get(code) as
    { expires_at: string } | undefined;
  return row?.expires_at;
}

/** Exchanges a valid code for a token; `null` when the code is unknown, used or expired. */
export function pair(
  db: DatabaseSync,
  code: string,
  clientName: string,
  now: Date,
): { token: string } | null {
  const row = db.prepare('SELECT expires_at, used_at FROM pairing_codes WHERE code = ?').get(code) as
    { expires_at: string; used_at: string | null } | undefined;
  if (!row || row.used_at || new Date(row.expires_at) < now) return null;
  const token = randomBytes(32).toString('base64url');
  db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ?').run(now.toISOString(), code);
  db.prepare('INSERT INTO clients (name, token_hash, created_at) VALUES (?, ?, ?)').run(
    clientName,
    hashToken(token),
    now.toISOString(),
  );
  return { token };
}

export function revokeClient(db: DatabaseSync, id: number): void {
  db.prepare('UPDATE clients SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function isValidToken(db: DatabaseSync, token: string): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM clients WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token)),
  );
}

export function requireToken(db: DatabaseSync): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !isValidToken(db, token))
      return c.json({ error: 'Jeton absent, invalide ou révoqué' }, 401);
    await next();
  };
}

/** First start: with no paired client yet, the pairing code of the first device goes to the logs. */
export function bootstrapPairing(db: DatabaseSync, now: Date, log: (line: string) => void): void {
  if (db.prepare('SELECT 1 FROM clients WHERE revoked_at IS NULL').get()) return;
  const code = issuePairingCode(db, now);
  log(`Aucun appareil appairé. Code d'appairage du premier appareil (10 min) : ${code}`);
}
