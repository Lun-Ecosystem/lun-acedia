import { describe, expect, it } from 'vitest';
import { SCENARIOS } from './scenarios.ts';

describe('Pina evaluation scenarios', () => {
  it('are at least 20, uniquely named, each with a non-empty expectation', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      const text = typeof s.text === 'function' ? s.text(new Date(2026, 9, 28)) : s.text;
      expect(text.length, s.name).toBeGreaterThan(0);
      expect(Object.keys(s.expect).length, s.name).toBeGreaterThan(0);
      if (s.expect.noAction) expect(s.expect.action ?? s.expect.card, s.name).toBeUndefined();
      if (s.expect.action) expect(s.expect.action, s.name).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});
