import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  test: {
    name: 'views',
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Svelte libraries ship .svelte sources (Bits UI, Lucide icons one by one): compile them in tests.
    server: { deps: { inline: [/bits-ui/, /@lucide\/svelte/, /svelte-toolbelt/, /runed/] } },
  },
});
