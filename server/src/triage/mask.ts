/*
 * What leaves Acedia from a mail (a synthesis, a reason, a title) goes through here: `mask` hides what looks
 * like a secret, `dropCopied` drops what copies the body. Pure: no I/O. JavaScript's `\s` already counts the
 * non-breaking spaces (U+00A0, U+202F) as spaces.
 */
export const MASKED = '[masqué]';

const KEYWORD =
  /(?<![\p{L}\p{N}])(?:codes?|pin|otp|mots? de passe|mdp|password|identifiants?|login|clés?|jetons?|tokens?)(?![\p{L}\p{N}])/giu;
const AFTER_SIGN = /^[^\S\n]*[:=][^\S\n]*(\S+)/u;
const NEXT_WORD = /^[^\S\n]+(\S+)/u;

/** After a keyword: the word after `:` or `=`, else the first of the next three words with a digit. */
function maskKeywords(text: string): string {
  let out = '';
  let from = 0;
  for (const m of text.matchAll(KEYWORD)) {
    const start = m.index + m[0].length;
    if (m.index < from) continue;
    const hit = secretAfter(text, start);
    if (!hit) continue;
    out += text.slice(from, hit.at) + MASKED;
    from = hit.at + hit.length;
  }
  return out + text.slice(from);
}

function secretAfter(text: string, start: number): { at: number; length: number } | undefined {
  const sign = AFTER_SIGN.exec(text.slice(start));
  if (sign) return { at: start + sign[0].length - sign[1]!.length, length: sign[1]!.length };
  let at = start;
  for (let i = 0; i < 3; i++) {
    const next = NEXT_WORD.exec(text.slice(at));
    if (!next) return undefined;
    const word = next[1]!;
    const wordAt = at + next[0].length - word.length;
    if (word.startsWith(MASKED)) return undefined; // already masked: stable on a second pass
    if (/\d/.test(word)) return { at: wordAt, length: word.length };
    at = wordAt + word.length;
    if (/[:=]$/.test(word)) return secretAfter(text, at - 1);
  }
  return undefined;
}

export function mask(text: string): string {
  // A link, `https?://` or `www.`, up to the next space.
  let out = text.replace(/(?:https?:\/\/|www\.)\S+/giu, MASKED);
  // An IBAN, spaced or not: two letters, two digits, then 11 to 30 letters or digits.
  out = out.replace(/(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[^\S\n]?[A-Z0-9]){11,30}(?![\p{L}\p{N}])/gu, MASKED);
  // A keyword (password, code, PIN, login): the word it introduces.
  out = maskKeywords(out);
  // A long run of digits (a card, a phone, a file number): 9 or more, split by at most one space, dot or dash,
  // one kind per run, so that a date and its hour (`2026-11-25 14:30`) stay.
  out = out.replace(/(?<!\p{N})(?:\d(?:[^\S\n]?\d){8,}|\d(?:\.?\d){8,}|\d(?:-?\d){8,})(?!\p{N})/gu, MASKED);
  // A lone one-time code: 6 to 8 glued digits, between word boundaries.
  out = out.replace(/(?<![\p{L}\p{N}])\d{6,8}(?![\p{L}\p{N}])/gu, MASKED);
  // A token (an API key, a JWT piece): 20 or more letters, digits, `_` or `-`, with a digit and a letter.
  return out.replace(/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}(?![\w-])/g, MASKED);
}

/** The words of a text, lower case, without accents or punctuation. */
const words = (text: string): string[] =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const WINDOW = 6;
const windows = (ws: string[]): string[] =>
  Array.from({ length: Math.max(0, ws.length - WINDOW + 1) }, (_, i) => ws.slice(i, i + WINDOW).join(' '));

/** The lines that share no run of six words with the body; a copied reason is passed as `[reason]`. */
export function dropCopied(lines: string[], body: string): string[] {
  const seen = new Set(windows(words(body)));
  return lines.filter((line) => !windows(words(line)).some((w) => seen.has(w)));
}
