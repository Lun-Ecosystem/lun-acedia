import { describe, expect, it } from 'vitest';
import source from '../../../server/src/types.ts?raw';
import copy from './types.ts?raw';

describe('types.ts', () => {
  it('is an exact copy of server/src/types.ts (npm run sync-types)', () => {
    expect(copy.slice(copy.indexOf('\n') + 1)).toBe(source);
  });
});
