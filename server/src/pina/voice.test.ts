import { describe, expect, it } from 'vitest';
import { PAUSED } from '../contract/routes.ts';
import { CAP, EMPTY, FAILED, TOO_LONG } from './agent.ts';
import { OVERLAP_REASONS } from './wording.ts';

// The agent's fixed sentences shown to the user speak in the neutral voice (ecriture.md, « La voix »).
const WORD =
  /(?<!\p{L})(je|me|ma|mon|mes|moi|tu|te|toi|ton|ta|tes|dis-moi|réessaie|choisis|reformule)(?![\p{L}-])/iu;
const ELIDED = /(?<!\p{L})[jmt]['’]/iu;

const texts: Record<string, string> = {
  PAUSED,
  CAP,
  TOO_LONG,
  EMPTY,
  ...Object.fromEntries(Object.entries(FAILED).map(([k, v]) => [`FAILED.${k}`, v])),
  'not-mine': OVERLAP_REASONS['not-mine']!,
};

describe('the voice of the fixed sentences', () => {
  it('reads the nine texts', () => {
    expect(Object.keys(texts)).toHaveLength(9);
  });

  it.each(Object.entries(texts))('%s says neither « je » nor « tu »', (_, text) => {
    expect(text).not.toMatch(WORD);
    expect(text).not.toMatch(ELIDED);
  });

  it('the check catches what it is meant to catch', () => {
    for (const bad of [
      'Dis-moi où',
      'J’ai fini',
      "j'ai",
      'tu peux',
      'Réessaie',
      'refuse ma clé',
      'm’a renvoyé',
    ]) {
      expect(WORD.test(bad) || ELIDED.test(bad)).toBe(true);
    }
    for (const ok of ['même', 'Acedia', 'À reformuler', 'test', 'Nouvel essai']) {
      expect(WORD.test(ok) || ELIDED.test(ok)).toBe(false);
    }
  });
});
