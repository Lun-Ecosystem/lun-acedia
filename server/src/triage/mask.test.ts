import { describe, expect, it } from 'vitest';
import { dropCopied, mask } from './mask.ts';

const NBSP = ' ';
const NNBSP = ' ';

// Fake secrets only: nothing here has the shape of a real provider key (no `sk-`, `ghp_`, `AKIA`).
const SECRETS: Record<string, [text: string, secret: string][]> = {
  link: [
    ['Réinitialiser ici : https://exemple.test/reset?token=abc merci', 'exemple.test/reset?token=abc'],
    ['Le lien www.exemple.test/r/abc expire ce soir', 'www.exemple.test/r/abc'],
    ['Voir http://exemple.test/x/42 pour la suite', 'exemple.test/x/42'],
  ],
  iban: [
    ['IBAN FR76 3000 6000 0112 3456 7890 189', 'FR76 3000 6000 0112 3456 7890 189'],
    ['Virement sur FR7630006000011234567890189 merci', 'FR7630006000011234567890189'],
    ['iban fr76 3000 6000 0112 3456 7890 189 merci', 'fr76 3000 6000 0112 3456 7890 189'],
    [`Compte de89${NNBSP}3704${NNBSP}0044${NNBSP}0532${NNBSP}0130${NNBSP}00 à vérifier`, `de89${NNBSP}3704`],
    [`Compte DE89${NBSP}3704${NBSP}0044${NBSP}0532${NBSP}0130${NBSP}00 Merci`, `DE89${NBSP}3704`],
  ],
  keyword: [
    ['Votre code est 4821', '4821'],
    ['Your verification code is 4821', '4821'],
    ['PIN : 1234', '1234'],
    [`PIN${NNBSP}:${NBSP}1234`, '1234'],
    ['mot de passe temporaire : Xk9#pL2q', 'Xk9#pL2q'],
    ['identifiant : jdupont pour entrer', 'jdupont'],
    ['login=dupont42', 'dupont42'],
  ],
  digits: [
    ['Carte 4970 1012 3456 7890 débitée', '4970 1012 3456 7890'],
    ['Rappeler le 06 12 34 56 78 demain', '06 12 34 56 78'],
    [`Rappeler le 06${NBSP}12${NBSP}34${NBSP}56${NBSP}78 demain`, '0612345678'],
    [`Rappeler le 06${NNBSP}12${NNBSP}34${NNBSP}56${NNBSP}78 demain`, '0612345678'],
    ['Dossier 123.456.789.01 ouvert', '12345678901'],
  ],
  otp: [
    ['Code de vérification : 482917', '482917'],
    ['482917 est valable dix minutes', '482917'],
    ['Saisir 5839201 pour entrer', '5839201'],
    ['Saisir (12345678) pour entrer', '12345678'],
  ],
  token: [
    ['jeton-faux-AAAABBBBCCCC1111DDDD', 'jeton-faux-AAAABBBBCCCC1111DDDD'],
    ['Utiliser faux_9f8e7d6c5b4a3f2e1d0c pour la démo', 'faux_9f8e7d6c5b4a3f2e1d0c'],
    ['abcdEFGH1234ijklMNOP5678 est la clef', 'abcdEFGH1234ijklMNOP5678'],
  ],
};

const STAYS = [
  'Rendez-vous le 25/11/2026',
  'Échéance 2026-11-25',
  'Le 2026-11-25 14:30',
  'Le 2026-11-25 à 14 h 30',
  'À 14 h 30',
  `À 14${NBSP}h${NBSP}30`,
  'Total 12,50 €',
  `Total 12,50${NNBSP}€`,
  'Bilan 2026',
  '3 mails à lire',
  'Écrire à nom@exemple.test',
  '12 rue des Lilas',
  'Une phrase sans aucun chiffre, ni lien, ni secret.',
  'La clé du problème est ailleurs.',
];

const digits = (s: string) => s.replace(/\D/g, '');

/** Nothing of the secret survives: neither whole, nor its digits glued together. */
function survives(out: string, secret: string): boolean {
  if (out.includes(secret)) return true;
  const d = digits(secret);
  return d.length >= 4 && digits(out).includes(d);
}

// A tiny seeded generator (mulberry32): the draws are the same on every run.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function draws(n: number): string[] {
  const r = rng(20261125);
  const int = (max: number) => Math.floor(r() * max);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const DIGIT = '0123456789';
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const ALNUM = UPPER + UPPER.toLowerCase() + DIGIT;
  const run = (alphabet: string, len: number) =>
    Array.from({ length: len }, () => pick([...alphabet])).join('');
  const grouped = (s: string, size: number, space: string) =>
    s.match(new RegExp(`.{1,${size}}`, 'g'))!.join(space);
  const families = [
    // Digits grouped by 2, 3 or 4, with plain or non-breaking spaces: a card, a phone, a file number.
    () => grouped(run(DIGIT, 9 + int(8)), pick([2, 3, 4]), pick([' ', NBSP, NNBSP])),
    // An IBAN, grouped by 4 or not.
    () => {
      const iban = run(UPPER, 2) + run(DIGIT, 2) + run(UPPER + DIGIT, 11 + int(20));
      const cased = r() < 0.5 ? iban : iban.toLowerCase();
      return r() < 0.5 ? cased : grouped(cased, 4, pick([' ', NBSP]));
    },
    // A token, with at least one letter and one digit.
    () => `jeton-faux-${run(ALNUM, 18 + int(20))}a1`,
  ];
  return Array.from({ length: n }, () => pick(families)());
}

describe('mask', () => {
  for (const [family, cases] of Object.entries(SECRETS)) {
    it(`masks every ${family}`, () => {
      expect(cases.length).toBeGreaterThanOrEqual(3);
      for (const [text, secret] of cases) {
        const out = mask(text);
        expect(out, text).toContain('[masqué]');
        expect(survives(out, secret), `${text} → ${out}`).toBe(false);
      }
    });
  }

  it('masks 500 drawn secrets, none survives', () => {
    for (const secret of draws(500)) {
      const out = mask(`Le numéro ${secret} est à garder pour la suite.`);
      expect(survives(out, secret), `${secret} → ${out}`).toBe(false);
    }
  });

  it('leaves what is no secret untouched', () => {
    for (const text of STAYS) expect(mask(text)).toBe(text);
  });

  it('is stable: masking twice gives the same text', () => {
    const all = [...Object.values(SECRETS).flatMap((c) => c.map(([t]) => t)), ...STAYS, ...draws(100)];
    for (const text of all) expect(mask(mask(text)), text).toBe(mask(text));
  });

  it('keeps the rest of the sentence, and an empty string stays empty', () => {
    expect(mask('Votre code est 4821, à saisir avant 14 h 30.')).toBe(
      'Votre code est [masqué] à saisir avant 14 h 30.',
    );
    expect(mask('')).toBe('');
    expect(mask('IBAN fr76 3000 6000 0112 3456 7890 189 merci')).toBe('IBAN [masqué] merci');
    expect(mask('IBAN FR76 3000 6000 0112 3456 7890 189 Merci')).toBe('IBAN [masqué] Merci');
  });
});

describe('dropCopied', () => {
  const body = 'Bonjour, le canari bleu chante sous la lune de novembre près du vieux moulin. À bientôt.';

  it('drops a line that copies six words of the body, whatever the case, accents or punctuation', () => {
    expect(dropCopied(['Le Canari bleu, chante sous la LUNE.'], body)).toEqual([]);
    expect(dropCopied(['le canari bleu chanté sous la lune'], body)).toEqual([]);
  });

  it('keeps a line that shares five words only, and the other lines', () => {
    expect(dropCopied(['Le canari bleu chante sous un arbre.', 'Un oiseau et la lune.'], body)).toEqual([
      'Le canari bleu chante sous un arbre.',
      'Un oiseau et la lune.',
    ]);
    expect(dropCopied(['Un rappel du moulin.', 'chante sous la lune de novembre'], body)).toEqual([
      'Un rappel du moulin.',
    ]);
  });

  it('a copied reason becomes empty', () => {
    expect(dropCopied(['sous la lune de novembre près du vieux moulin'], body).join('')).toBe('');
  });
});
