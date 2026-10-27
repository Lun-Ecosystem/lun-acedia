import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');

describe("room under lists for Pina's launcher", () => {
  it('is one custom property, derived from the launcher size and offset, and nil on a phone', () => {
    const base = read('base.css');
    expect(base.match(/^\s+--pina-coin:/gm)).toHaveLength(2);
    expect(base).toMatch(/--pina-coin: calc\(var\(--pina-lanceur-h\) \+ var\(--pina-lanceur-bas\)/);
    expect(base).toMatch(/max-width: 767\.98px\) \{\s*:root \{\s*--pina-coin: 0px/);
    const launcher = read('pina/Launcher.svelte');
    expect(launcher).toContain('bottom: var(--pina-lanceur-bas)');
    expect(launcher).toContain('height: var(--pina-lanceur-h)');
  });

  it("is applied by the scrolling lists, and nothing in the panel's state touches it", () => {
    for (const f of [
      'mail/Mailbox.svelte',
      'mail/Journal.svelte',
      'mail/Pending.svelte',
      'agenda/Tasks.svelte',
      'agenda/PlanningView.svelte',
      'agenda/MonthView.svelte',
      'agenda/CalendarGrid.svelte',
      'settings/Settings.svelte',
    ])
      expect(read(f), f).toContain('var(--pina-coin)');
    expect(read('pina/PinaPanel.svelte')).not.toContain('--pina-coin');
  });
});
