import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db.ts';
import { makeHarness } from '../testing/harness.ts';
import { emitEvent, eventsSince, pruneEvents, subscribe } from './events.ts';

/** Reads SSE frames from a streaming response until `count` events arrived. */
async function readEvents(
  res: Response,
  count: number,
): Promise<{ id: string; event: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: { id: string; event: string; data: unknown }[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const fields = Object.fromEntries(
        raw
          .split('\n')
          .filter((l) => l && !l.startsWith(':'))
          .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
      );
      if (fields.id && fields.event && fields.data)
        frames.push({ id: fields.id, event: fields.event, data: JSON.parse(fields.data) });
    }
  }
  await reader.cancel();
  return frames;
}

describe('lines', () => {
  it('keeps the lines of an event', () => {
    const h = makeHarness();
    const now = new Date('2026-11-02T08:00:00.000Z');
    emitEvent(h.db, { type: 't', importance: 'urgent', title: 'x', lines: ['a', 'b'] }, now);
    emitEvent(h.db, { type: 't', importance: 'urgent', title: 'y' }, now);
    const [a, b] = eventsSince(h.db);
    expect(a).toMatchObject({ lines: ['a', 'b'] });
    expect(b).not.toHaveProperty('lines');
  });
});

describe('GET /lun/v1/events', () => {
  it('replays the events after Last-Event-ID, in order', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const first = emitEvent(h.db, { type: 'mail.triaged', importance: 'normal', title: 'Un' }, h.clock());
    emitEvent(h.db, { type: 'mail.pending', importance: 'info', title: 'Deux' }, h.clock());
    emitEvent(h.db, { type: 'agenda.reminder', importance: 'urgent', title: 'Trois' }, h.clock());
    const res = await h.app.request('/lun/v1/events', {
      headers: { ...h.auth(token), 'last-event-id': first.id },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readEvents(res, 2);
    expect(frames.map((f) => f.event)).toEqual(['mail.pending', 'agenda.reminder']);
    expect(frames[1]!.data).toEqual({
      id: frames[1]!.id,
      type: 'agenda.reminder',
      importance: 'urgent',
      at: '2026-11-02T08:00:00.000Z',
      title: 'Trois',
    });
  });

  it('pushes an event emitted while the client is connected', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    const res = await h.app.request('/lun/v1/events', { headers: h.auth(token) });
    setTimeout(
      () => emitEvent(h.db, { type: 'mail.changed', importance: 'info', title: 'Live' }, h.clock()),
      20,
    );
    const frames = await readEvents(res, 1);
    expect(frames[0]!.event).toBe('mail.changed');
  });

  it('gives increasing string ids', () => {
    const h = makeHarness();
    const a = emitEvent(h.db, { type: 't', importance: 'info', title: 'a' }, h.clock());
    const b = emitEvent(h.db, { type: 't', importance: 'info', title: 'b' }, h.clock());
    expect(typeof a.id).toBe('string');
    expect(Number(b.id)).toBeGreaterThan(Number(a.id));
    expect(eventsSince(h.db, a.id).map((e) => e.title)).toEqual(['b']);
  });

  it('keeps events for 7 days', () => {
    const h = makeHarness();
    emitEvent(h.db, { type: 't', importance: 'info', title: 'old' }, new Date('2026-10-25T07:59:00Z'));
    emitEvent(h.db, { type: 't', importance: 'info', title: 'recent' }, new Date('2026-10-26T08:01:00Z'));
    pruneEvents(h.db, h.clock());
    expect(eventsSince(h.db).map((e) => e.title)).toEqual(['recent']);
  });
});

describe('the mask of the mail events', () => {
  const secret = { title: 'Votre code 482917', lines: ['De : Prof', 'Lien www.exemple.test/r/abc'] };
  const masked = { title: 'Votre code [masqué]', lines: ['De : Prof', 'Lien [masqué]'] };

  it('masks the title and the lines of a mail event, live and in eventsSince', () => {
    const h = makeHarness();
    const live: unknown[] = [];
    const stop = subscribe(h.db, (e) => live.push(e));
    const emitted = emitEvent(h.db, { type: 'mail.triaged', importance: 'urgent', ...secret }, h.clock());
    stop();
    expect(emitted).toMatchObject(masked);
    expect(live[0]).toMatchObject(masked);
    expect(eventsSince(h.db)[0]).toMatchObject(masked);
  });

  it('masks a mail event in the replay of GET /lun/v1/events', async () => {
    const h = makeHarness();
    const token = await h.pairClient();
    emitEvent(h.db, { type: 'mail.triaged', importance: 'urgent', ...secret }, h.clock());
    const res = await h.app.request('/lun/v1/events', {
      headers: { ...h.auth(token), 'last-event-id': '0' },
    });
    const [frame] = await readEvents(res, 1);
    expect(frame!.data).toMatchObject(masked);
  });

  it('leaves the agenda, price and key events as they are', () => {
    const h = makeHarness();
    for (const type of ['agenda.reminder', 'llm.unknown-price', 'key.invalid'])
      emitEvent(h.db, { type, importance: 'normal', ...secret }, h.clock());
    for (const e of eventsSince(h.db)) expect(e).toMatchObject(secret);
  });
});

describe('the migration of the old events', () => {
  it('takes the « Extrait : » lines out of the events already in the base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acedia-events-'));
    try {
      const path = join(dir, 'old.db');
      const db = openDb(path);
      const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
      db.prepare(
        "INSERT INTO events (type, importance, at, title, lines) VALUES ('mail.triaged', 'urgent', ?, 'x', ?)",
      ).run('2026-11-02T08:00:00.000Z', JSON.stringify(['De : Prof', 'Extrait : le début du mail']));
      db.prepare(
        "INSERT INTO events (type, importance, at, title, lines) VALUES ('agenda.reminder', 'urgent', ?, 'y', ?)",
      ).run('2026-11-02T08:00:00.000Z', JSON.stringify(['À 14 h']));
      // Back to the base before the last migration, the one that cleans the events.
      db.prepare('UPDATE schema_version SET version = ?').run(version - 1);
      db.close();
      const migrated = openDb(path);
      try {
        expect(eventsSince(migrated).map((e) => e.lines)).toEqual([['De : Prof'], ['À 14 h']]);
      } finally {
        migrated.close();
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // a lock held by Windows: the temp folder is cleaned later
      }
    }
  });
});
