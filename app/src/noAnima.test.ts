import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const roots = ['../../app/src', '../../views/src'].map((p) => fileURLToPath(new URL(p, import.meta.url)));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    // tokens.css is the generated copy of the shared reference, which names every world.
    if (entry.name === 'tokens.css') return [];
    return /\.(ts|svelte|css|html)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('standalone front', () => {
  it('no "Anima" in the standalone front', () => {
    const files = roots.flatMap(sources);
    expect(files.length).toBeGreaterThan(10);
    // Case-insensitive; `animation` (CSS) is not the name.
    const offenders = files.filter((f) => /anima(?![a-z])/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
