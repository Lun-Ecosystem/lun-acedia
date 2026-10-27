import { describe, expect, it } from 'vitest';
import source from '../../../server/src/types.ts?raw';
import wordingSource from '../../../server/src/pina/wording.ts?raw';
import copy from './types.ts?raw';
import wordingCopy from './pina/wording.ts?raw';

const body = (text: string) => text.slice(text.indexOf('\n') + 1);

describe('copies of the server files (npm run sync-types)', () => {
  it('types.ts is an exact copy of server/src/types.ts', () => {
    expect(body(copy)).toBe(source);
  });

  it('pina/wording.ts is an exact copy of server/src/pina/wording.ts', () => {
    expect(body(wordingCopy)).toBe(wordingSource);
  });

  it('no file of the package imports the server', () => {
    const files = import.meta.glob('./**/*.{ts,svelte}', { query: '?raw', import: 'default', eager: true });
    const offenders = Object.entries(files)
      .filter(
        ([path, text]) =>
          !path.endsWith('types.test.ts') && /from\s+['"][^'"]*server\/src/.test(text as string),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
