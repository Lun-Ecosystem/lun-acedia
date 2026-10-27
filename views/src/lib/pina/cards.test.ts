import { describe as group, expect, it } from 'vitest';
import * as icons from '../ui/Icon.ts';
import { describe } from './cards.ts';

group('describe: the front adds the icon to the server wording', () => {
  const names = { labels: new Map(), targets: new Map() };
  it('picks the icon of the action', () => {
    expect(describe({ action: 'mail.archive', input: { id: 'm1' } }, names)).toMatchObject({
      icon: icons.Archive,
      title: 'Archiver un mail',
    });
    expect(describe({ action: 'task.update', input: { id: 't', done: true } }, names).icon).toBe(icons.Check);
    expect(describe({ action: 'task.update', input: { id: 't', notes: 'x' } }, names).icon).toBe(icons.List);
    expect(describe({ action: 'nope', input: {} }, names).icon).toBe(icons.Sparkles);
  });
});
