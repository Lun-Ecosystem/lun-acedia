// DEV ONLY: `npm run demo` (after `npm run build`). Serves app/dist on invented data, port 8797.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDemo } from './demo.ts';

// No network at all: any fetch that is not the fake one (handed to the app) fails.
globalThis.fetch = () => Promise.reject(new Error('demo : réseau interdit'));

const staticDir = resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'app/dist');
if (!existsSync(resolve(staticDir, 'index.html'))) {
  console.error('app/dist absent : lancer « npm run build » d’abord.');
  process.exit(1);
}
const { app, token } = await createDemo({ staticDir });
const port = Number(process.env.DEMO_PORT ?? 8797);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`Démo Lun'Acedia (données inventées) : http://localhost:${port}`);
  console.log('Appareil déjà appairé. Dans la console du navigateur, sur cette page :');
  console.log(`  localStorage.setItem('lunacedia.token', '${token}'); location.reload()`);
});
