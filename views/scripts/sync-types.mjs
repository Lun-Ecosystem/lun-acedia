// Copies the API types of the server into the views package, which cannot import the server.
// A test (src/lib/types.test.ts) fails when the copy drifts from the source.
import { readFileSync, writeFileSync } from 'node:fs';

export const HEADER =
  '// Copie de server/src/types.ts, à ne pas modifier : lancer `npm run sync-types -w @lun-ecosystem/lunacedia-views`.\n';

const source = new URL('../../server/src/types.ts', import.meta.url);
const target = new URL('../src/lib/types.ts', import.meta.url);
writeFileSync(target, HEADER + readFileSync(source, 'utf8'));
