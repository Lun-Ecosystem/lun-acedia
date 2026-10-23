/*
 * How a mail body is shown in the dark interface (spec §3.2). A mail without a background of its own
 * (plain text, lightly styled HTML) takes the colors of the theme: `sombre`. A mail laid out with its
 * own backgrounds (newsletter, rich invoice) keeps its colors on a light rounded card: `papier`.
 */

export type MailTheme = 'sombre' | 'papier';

/** Backgrounds that say nothing of a layout (white, written with or without `#`, or none). */
const NEUTRAL = new Set(['white', 'fff', 'ffffff', 'transparent', 'none']);

const BGCOLOR = /\bbgcolor\s*=\s*["']?([^"'\s>]+)/gi;
const BACKGROUND = /\bbackground(?:-color)?\s*:\s*([^;}"]+)/gi;

const neutral = (value: string) =>
  NEUTRAL.has(
    value
      .replace(/!important/i, '')
      .trim()
      .toLowerCase()
      .replace(/^#/, ''),
  );

export function mailTheme(html: string): MailTheme {
  for (const [, value] of html.matchAll(BGCOLOR)) if (!neutral(value!)) return 'papier';
  for (const [, value] of html.matchAll(BACKGROUND)) if (!neutral(value!)) return 'papier';
  return 'sombre';
}
