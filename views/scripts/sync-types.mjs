// Copies the server files the views need into the views package, which cannot import the server.
// A test (src/lib/types.test.ts) fails when a copy drifts from its source.
import { readFileSync, writeFileSync } from 'node:fs';

const header = (from) =>
  `// Copie de ${from}, à ne pas modifier : lancer \`npm run sync-types -w @lun-ecosystem/lunacedia-views\`.\n`;

for (const [from, to] of [
  ['server/src/types.ts', 'views/src/lib/types.ts'],
  ['server/src/pina/wording.ts', 'views/src/lib/pina/wording.ts'],
]) {
  const root = new URL('../../', import.meta.url);
  writeFileSync(new URL(to, root), header(from) + readFileSync(new URL(from, root), 'utf8'));
}
