import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

const views = (path: string) => fileURLToPath(new URL(`../views/src/lib/${path}`, import.meta.url));

export default defineConfig({
  plugins: [
    svelte(),
    // Component tests: browser build of Svelte and cleanup between tests (no effect on the build).
    ...(process.env.VITEST ? [svelteTesting()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      // Only the app shell is cached: mail and agenda always come live from the server.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/*-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-*'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/lun\//, /^\/oauth\//],
        runtimeCaching: [],
      },
      manifest: {
        name: "Lun'Acedia",
        short_name: 'Acedia',
        description: 'Mail, agenda et tâches de l’écosystème Lun’.',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        theme_color: '#3A6080',
        background_color: '#0D0B09',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  resolve: {
    // One copy of each view: the app compiles them straight from views/.
    alias: [
      { find: '@lun-ecosystem/lunacedia-views/styles.css', replacement: views('styles.css') },
      { find: '@lun-ecosystem/lunacedia-views/client', replacement: views('client.ts') },
      { find: /^@lun-ecosystem\/lunacedia-views$/, replacement: views('index.ts') },
    ],
  },
  build: {
    // Only the app is built. catalogue.html (components in every state) is a development page: Vite dev
    // serves any root html file, the build takes this input alone.
    rolldownOptions: { input: fileURLToPath(new URL('index.html', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/lun': 'http://localhost:8787',
      '/oauth': 'http://localhost:8787',
    },
  },
  test: {
    name: 'app',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Svelte libraries ship .svelte sources (Bits UI, Lucide icons one by one): compile them in tests.
    server: { deps: { inline: [/bits-ui/, /@lucide\/svelte/, /svelte-toolbelt/, /runed/] } },
  },
});
