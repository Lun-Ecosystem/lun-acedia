import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findHardcodedColors } from './check-colors.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-colors-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('findHardcodedColors', () => {
  it('flags hex, rgb, rgba and hsl colors with their line', () => {
    const svelte = write(
      'A.svelte',
      '<style>\n  a { color: #3a6080; }\n  b { color: rgb(1, 2, 3); }\n</style>\n',
    );
    const ts = write('b.ts', "const a = 'rgba(0,0,0,.5)';\nconst b = 'hsl(10 20% 30%)';\n");
    expect(findHardcodedColors([svelte, ts])).toEqual([
      { file: svelte, line: 2 },
      { file: svelte, line: 3 },
      { file: ts, line: 1 },
      { file: ts, line: 2 },
    ]);
  });

  it('ignores tokens.css and test files', () => {
    const tokens = write('tokens.css', ':root { --a: #fff; }\n');
    const test = write('x.test.ts', "const a = '#fff';\n");
    expect(findHardcodedColors([tokens, test])).toEqual([]);
  });

  it('ignores block, line and html comments', () => {
    const file = write(
      'C.svelte',
      '<!-- #fff -->\n<style>\n  /* color: #fff;\n     rgb(0,0,0) */\n  a { color: var(--texte); }\n</style>\n<script>\n  // #123456\n  const x = 1; // rgb(1,2,3)\n</script>\n',
    );
    expect(findHardcodedColors([file])).toEqual([]);
  });

  it('does not flag color-mix on tokens', () => {
    const file = write(
      'D.svelte',
      '<style>\n a { background: color-mix(in srgb, var(--x) 20%, transparent); }\n</style>\n',
    );
    expect(findHardcodedColors([file])).toEqual([]);
  });

  it('does not flag anchors and ids that look like hex', () => {
    const file = write(
      'F.svelte',
      '<a href="#fade">x</a>\n<a href="#add">y</a>\n<p id="#dead">z</p>\n<style>\n  a#dead:hover {\n    margin: 0;\n  }\n  .x #bad {\n  }\n</style>\n',
    );
    expect(findHardcodedColors([file])).toEqual([]);
  });

  it('flags a declaration and a quoted hex', () => {
    const file = write(
      'G.svelte',
      "<style>\n a { color: #fff; }\n</style>\n<script>\n  const c = '#3A6080';\n</script>\n",
    );
    expect(findHardcodedColors([file])).toEqual([
      { file, line: 2 },
      { file, line: 5 },
    ]);
  });

  it('keeps the line numbers after a multi-line comment', () => {
    const file = write('E.svelte', '/* a\nb\nc */\nx { color: #abc; }\n');
    expect(findHardcodedColors([file])).toEqual([{ file, line: 4 }]);
  });
});
