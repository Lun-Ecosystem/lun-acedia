import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { openDb } from '../db.ts';
import { createGoogleClient, saveTokens } from '../google/client.ts';
import { fakeFetch } from '../testing/fake-fetch.ts';
import { FakeGmail, message } from '../testing/fake-gmail.ts';
import { getStoredMessage, messageCount, upsertMessage } from './store.ts';
import { syncGmail } from './sync.ts';

const secretKey = randomBytes(32).toString('base64');
const config = { clientId: 'id', clientSecret: 's', redirectUri: 'http://localhost/cb' };

function setup(gmail: FakeGmail, opts: { initialMails?: number } = {}) {
  const db = openDb(':memory:');
  let now = new Date('2026-11-02T08:00:00.000Z');
  saveTokens(db, secretKey, { accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' });
  const fake = fakeFetch(gmail.handler);
  const google = createGoogleClient({ db, fetch: fake.fetch, now: () => now, config, secretKey });
  return {
    db,
    calls: fake.calls,
    sync: () => syncGmail({ db, google, now: () => now, ...opts }),
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

const old = (id: string, extra: Partial<Parameters<typeof message>[0]> = {}) =>
  message({ id, date: '2026-10-20T10:00:00.000Z', ...extra });
const fresh = (id: string, extra: Partial<Parameters<typeof message>[0]> = {}) =>
  message({ id, date: '2026-11-02T08:30:00.000Z', ...extra });

describe('syncGmail', () => {
  it('first pass caches the mails, stores the historyId and triages nothing', async () => {
    const gmail = new FakeGmail([
      old('a'),
      old('b', { labelIds: ['SPAM'] }),
      old('c', { labelIds: ['TRASH'] }),
    ]);
    const s = setup(gmail);
    const result = await s.sync();
    expect(result.added).toEqual([]);
    expect(messageCount(s.db)).toBe(3);
    expect(getStoredMessage(s.db, 'a')).toMatchObject({
      from: { name: 'Prof Martin', addr: 'prof@ecole.fr' },
      subject: 'Sujet a',
      unread: true,
      labels: ['INBOX', 'UNREAD'],
    });
  });

  it('reports a mail delivered after the first pass as added', async () => {
    const gmail = new FakeGmail([old('a')]);
    const s = setup(gmail);
    await s.sync();
    gmail.deliver(fresh('n1'));
    const result = await s.sync();
    expect(result.added).toEqual(['n1']);
    expect(getStoredMessage(s.db, 'n1')?.subject).toBe('Sujet n1');
  });

  it('does not report a sent mail or a draft as added', async () => {
    const gmail = new FakeGmail([old('a')]);
    const s = setup(gmail);
    await s.sync();
    gmail.deliver(fresh('sent', { labelIds: ['SENT'] }));
    gmail.deliver(fresh('draft', { labelIds: ['DRAFT'] }));
    const result = await s.sync();
    expect(result.added).toEqual([]);
    expect(messageCount(s.db)).toBe(3);
  });

  it('follows a label change made in Gmail', async () => {
    const gmail = new FakeGmail([old('a')]);
    const s = setup(gmail);
    await s.sync();
    gmail.relabel('a', ['Label_9'], ['INBOX', 'UNREAD']);
    const result = await s.sync();
    expect(result.changed).toEqual(['a']);
    expect(getStoredMessage(s.db, 'a')?.labels).toEqual(['Label_9']);
    expect(getStoredMessage(s.db, 'a')?.unread).toBe(false);
  });

  it('forgets a mail deleted in Gmail', async () => {
    const gmail = new FakeGmail([old('a'), old('b')]);
    const s = setup(gmail);
    await s.sync();
    gmail.purge('a');
    const result = await s.sync();
    expect(result.removed).toEqual(['a']);
    expect(getStoredMessage(s.db, 'a')).toBeUndefined();
  });

  it('resyncs fully when the history expired, without duplicates', async () => {
    const gmail = new FakeGmail([old('a'), old('b')]);
    const s = setup(gmail);
    await s.sync();
    gmail.relabel('a', [], ['INBOX']);
    gmail.expireHistory();
    const result = await s.sync();
    expect(messageCount(s.db)).toBe(2);
    expect(getStoredMessage(s.db, 'a')?.labels).toEqual(['UNREAD']);
    expect(result.added).toEqual([]);
  });

  it('a full resync keeps the older mails cached beyond the first listing', async () => {
    const older = message({ id: 'older', date: '2026-09-01T10:00:00.000Z' });
    const gmail = new FakeGmail([old('a'), older]);
    const s = setup(gmail, { initialMails: 1 });
    await s.sync();
    upsertMessage(s.db, older); // opened from a search
    gmail.relabel('a', ['STARRED'], []);
    gmail.expireHistory();
    const result = await s.sync();
    expect(result.removed).toEqual([]);
    expect(getStoredMessage(s.db, 'older')).toBeDefined();
  });

  it('still reports a mail that arrived during an expired history gap', async () => {
    const gmail = new FakeGmail([old('a')]);
    const s = setup(gmail);
    await s.sync();
    gmail.deliver(fresh('gap'));
    gmail.expireHistory();
    const result = await s.sync();
    expect(result.added).toEqual(['gap']);
  });

  it('emits mail.changed only when something moved', async () => {
    const gmail = new FakeGmail([old('a')]);
    const s = setup(gmail);
    await s.sync();
    const before = eventsSince(s.db).filter((e) => e.type === 'mail.changed').length;
    await s.sync();
    expect(eventsSince(s.db).filter((e) => e.type === 'mail.changed')).toHaveLength(before);
    gmail.deliver(fresh('n'));
    await s.sync();
    const changed = eventsSince(s.db).filter((e) => e.type === 'mail.changed');
    expect(changed).toHaveLength(before + 1);
    expect(changed.at(-1)!.importance).toBe('log');
  });

  it('skips a mail deleted between the history and its fetch', async () => {
    const gmail = new FakeGmail([old('a')]);
    const s = setup(gmail);
    await s.sync();
    gmail.deliver(fresh('ghost'));
    gmail.messages.delete('ghost');
    const result = await s.sync();
    expect(result.added).toEqual([]);
    expect(getStoredMessage(s.db, 'ghost')).toBeUndefined();
  });
});
