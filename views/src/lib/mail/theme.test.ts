import { describe, expect, it } from 'vitest';
import { mailTheme } from './theme.ts';

describe('mailTheme', () => {
  it('a plain text mail takes the dark theme', () => {
    expect(mailTheme('<pre>Bonjour,\nà demain.</pre>')).toBe('sombre');
    expect(mailTheme('Bonjour, à demain.')).toBe('sombre');
  });

  it('an HTML mail without a background of its own takes the dark theme', () => {
    expect(mailTheme('<div><p>Bonjour</p><a href="https://example.com">lien</a></div>')).toBe('sombre');
  });

  it('a text color alone does not make a laid-out mail', () => {
    expect(mailTheme('<p style="color:#333">Bonjour</p>')).toBe('sombre');
    expect(mailTheme('<style>p { color: #333; }</style><p>Bonjour</p>')).toBe('sombre');
  });

  it('a white or transparent background stays dark', () => {
    for (const value of ['white', '#fff', '#FFFFFF', 'transparent'])
      expect(mailTheme(`<body style="background-color: ${value}"><p>Bonjour</p></body>`), value).toBe(
        'sombre',
      );
    expect(mailTheme('<style>body { background: #ffffff !important; }</style><p>Bonjour</p>')).toBe('sombre');
    expect(mailTheme('<table bgcolor="#ffffff"><tr><td>Bonjour</td></tr></table>')).toBe('sombre');
    expect(mailTheme("<div style='background:#fff'>Bonjour</div>")).toBe('sombre');
  });

  it('a mail with a bgcolor goes on the paper card', () => {
    expect(mailTheme('<table bgcolor="#1a73e8"><tr><td>Bonjour</td></tr></table>')).toBe('papier');
    expect(mailTheme("<td bgcolor='f4f4f4'>Bonjour</td>")).toBe('papier');
  });

  it('a mail with a background of its own goes on the paper card', () => {
    expect(mailTheme('<div style="background-color:#f4f4f4">Facture</div>')).toBe('papier');
    expect(mailTheme('<div style="background: rgb(0, 51, 102)">Lettre</div>')).toBe('papier');
    expect(
      mailTheme('<style>.head { background: url(fond.png) #fff; }</style><div class="head"></div>'),
    ).toBe('papier');
  });
});
