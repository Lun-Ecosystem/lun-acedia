import { describe, expect, it } from 'vitest';
import { unreadCount } from './format.ts';

describe('unreadCount', () => {
  it('shows nothing for zero, the number otherwise', () => {
    expect(unreadCount(0)).toBeUndefined();
    expect(unreadCount(undefined)).toBeUndefined();
    expect(unreadCount(1)).toBe(1);
    expect(unreadCount(120)).toBe(120);
  });
});
