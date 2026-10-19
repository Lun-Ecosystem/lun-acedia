import { describe, expect, it } from 'vitest';
import { VIEWS_PACKAGE } from './index.ts';

describe('views package', () => {
  it('carries its published name', () => {
    expect(VIEWS_PACKAGE).toBe('@lun-ecosystem/lunacedia-views');
  });
});
