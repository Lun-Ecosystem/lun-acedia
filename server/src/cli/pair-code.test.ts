import { describe, expect, it } from 'vitest';
import { pair } from '../contract/auth.ts';
import { openDb } from '../db.ts';
import { pairCodeLine } from './pair-code.ts';

describe('pair-code', () => {
  it('pair-code works whether clients exist or not', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-11-02T08:00:00.000Z');
    const first = pairCodeLine(db, now);
    expect(first).toMatch(/^Code d'appairage \(10 min\) : \d{6}$/);
    expect(pair(db, first.slice(-6), 'laptop', now)).not.toBeNull();
    const second = pairCodeLine(db, now);
    expect(second).toMatch(/^Code d'appairage \(10 min\) : \d{6}$/);
    expect(pair(db, second.slice(-6), 'phone', now)).not.toBeNull();
  });
});
