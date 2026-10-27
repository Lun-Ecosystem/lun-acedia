import { describe, expect, it } from 'vitest';
import { openDb } from '../db.ts';
import {
  addCard,
  appendMessage,
  cardsOf,
  dayOf,
  days,
  expireOld,
  getCard,
  messagesOf,
  pendingCount,
  pendingInTurn,
  pinaSettings,
  purge,
  putPinaSettings,
  setCardStatus,
} from './store.ts';

const card = (day: string, turn = 1, callId = 'c1') => ({
  day,
  turn,
  callId,
  action: 'mail.trash',
  input: { id: 'm1' },
  effect: 'delete' as const,
  now: new Date('2026-07-01T10:00:00Z'),
});

describe('pina store', () => {
  it('dayOf switches at Paris midnight (UTC 22:00 in summer, 23:00 in winter)', () => {
    expect(dayOf(new Date('2026-07-01T21:59:59Z'))).toBe('2026-07-01');
    expect(dayOf(new Date('2026-07-01T22:00:00Z'))).toBe('2026-07-02');
    expect(dayOf(new Date('2026-01-15T22:59:59Z'))).toBe('2026-01-15');
    expect(dayOf(new Date('2026-01-15T23:00:00Z'))).toBe('2026-01-16');
  });

  it('keeps messages of a day in order, with the ChatMessage as JSON', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-07-01T10:00:00Z');
    const a = appendMessage(db, '2026-07-01', { role: 'user', text: 'salut' }, now);
    appendMessage(db, '2026-07-01', { role: 'assistant', text: 'yo', toolCalls: [] }, now);
    appendMessage(db, '2026-07-02', { role: 'user', text: 'autre jour' }, now);
    expect(messagesOf(db, '2026-07-01').map((m) => m.message.role)).toEqual(['user', 'assistant']);
    expect(messagesOf(db, '2026-07-01')[0]).toMatchObject({ id: a, message: { text: 'salut' } });
    expect(days(db)).toEqual([
      { day: '2026-07-02', messages: 1 },
      { day: '2026-07-01', messages: 2 },
    ]);
  });

  it('setCardStatus from pending twice → second returns false', () => {
    const db = openDb(':memory:');
    const id = addCard(db, card('2026-07-01'));
    expect(getCard(db, id)).toMatchObject({ status: 'pending', input: { id: 'm1' }, effect: 'delete' });
    const at = new Date('2026-07-01T11:00:00Z');
    expect(setCardStatus(db, id, 'pending', 'done', { result: { ok: 1 }, at })).toBe(true);
    expect(setCardStatus(db, id, 'pending', 'refused', { at })).toBe(false);
    expect(getCard(db, id)).toMatchObject({ status: 'done', result: { ok: 1 } });
  });

  it('pendingInTurn counts only that turn’s pending cards', () => {
    const db = openDb(':memory:');
    const a = addCard(db, card('2026-07-01', 1, 'a'));
    addCard(db, card('2026-07-01', 1, 'b'));
    addCard(db, card('2026-07-01', 2, 'c'));
    expect(pendingInTurn(db, 1)).toBe(2);
    setCardStatus(db, a, 'pending', 'refused', { at: new Date() });
    expect(pendingInTurn(db, 1)).toBe(1);
    expect(pendingInTurn(db, 2)).toBe(1);
    expect(pendingCount(db, '2026-07-01')).toBe(2);
  });

  it('expireOld marks yesterday’s pending cards expired', () => {
    const db = openDb(':memory:');
    const old = addCard(db, card('2026-06-30'));
    const today = addCard(db, card('2026-07-01', 2, 'c2'));
    expireOld(db, '2026-07-01');
    expect(getCard(db, old)?.status).toBe('expired');
    expect(getCard(db, today)?.status).toBe('pending');
    expect(cardsOf(db, '2026-07-01')).toHaveLength(1);
  });

  it('purge drops days older than retentionDays and keeps today', () => {
    const db = openDb(':memory:');
    const now = new Date();
    for (const d of ['2026-05-01', '2026-05-31', '2026-07-01']) {
      appendMessage(db, d, { role: 'user', text: d }, now);
      addCard(db, card(d));
    }
    purge(db, '2026-07-01', 30);
    expect(days(db).map((d) => d.day)).toEqual(['2026-07-01']);
    expect(cardsOf(db, '2026-05-31')).toHaveLength(0);
    expect(cardsOf(db, '2026-07-01')).toHaveLength(1);
  });

  it('has defaults, never written, and stores changes', () => {
    const db = openDb(':memory:');
    expect(pinaSettings(db)).toEqual({
      mode: 'validate',
      instructions: '',
      retentionDays: 30,
      dailyCapUsd: 1,
    });
    expect(db.prepare("SELECT 1 FROM settings WHERE key LIKE 'pina.%'").get()).toBeUndefined();
    putPinaSettings(db, { mode: 'immediate', dailyCapUsd: 2.5 });
    expect(pinaSettings(db)).toMatchObject({ mode: 'immediate', retentionDays: 30, dailyCapUsd: 2.5 });
  });

  it('retentionDays bounded 1..365', () => {
    const db = openDb(':memory:');
    expect(() => putPinaSettings(db, { retentionDays: 0 })).toThrow();
    expect(() => putPinaSettings(db, { retentionDays: 366 })).toThrow();
    expect(() => putPinaSettings(db, { retentionDays: 1.5 })).toThrow();
    putPinaSettings(db, { retentionDays: 365 });
    expect(pinaSettings(db).retentionDays).toBe(365);
  });

  it('dailyCapUsd bounded 0..50', () => {
    const db = openDb(':memory:');
    expect(() => putPinaSettings(db, { dailyCapUsd: -1 })).toThrow();
    expect(() => putPinaSettings(db, { dailyCapUsd: 50.01 })).toThrow();
    putPinaSettings(db, { dailyCapUsd: 0 });
    expect(pinaSettings(db).dailyCapUsd).toBe(0);
  });
});
