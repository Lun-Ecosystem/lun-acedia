import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations. Adding one means appending to the list, never editing a past entry:
 * `schema_version` records how many have run.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE clients (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     revoked_at TEXT
   );
   CREATE TABLE pairing_codes (code TEXT PRIMARY KEY, expires_at TEXT NOT NULL, used_at TEXT);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     type TEXT NOT NULL,
     importance TEXT NOT NULL,
     at TEXT NOT NULL,
     title TEXT NOT NULL,
     data TEXT
   );
   CREATE TABLE costs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT,
     amount REAL NOT NULL,
     calls INTEGER NOT NULL
   );`,
  `CREATE TABLE google_tokens (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     access_token TEXT NOT NULL,
     refresh_token TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     email TEXT
   );
   CREATE TABLE oauth_states (state TEXT PRIMARY KEY, created_at TEXT NOT NULL);`,
  `CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     label_ids TEXT NOT NULL,
     from_addr TEXT NOT NULL,
     from_name TEXT,
     to_addrs TEXT NOT NULL,
     subject TEXT NOT NULL,
     snippet TEXT NOT NULL,
     internal_date INTEGER NOT NULL,
     unread INTEGER NOT NULL,
     has_attachments INTEGER NOT NULL
   );
   CREATE INDEX messages_by_date ON messages (internal_date DESC, id DESC);
   CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

/** Reads a JSON value from the settings table. */
export function getSetting<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function putSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}
