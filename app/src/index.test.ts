import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index.ts';

describe('standalone app', () => {
  it('is named after the satellite', () => {
    expect(APP_NAME).toBe("Lun'Acedia");
  });
});
