import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'server', include: ['server/src/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'scripts', include: ['scripts/**/*.test.ts'], environment: 'node' } },
      'app/vite.config.ts',
      'views/vitest.config.ts',
    ],
  },
});
