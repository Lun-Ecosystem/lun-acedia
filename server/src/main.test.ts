import { afterEach, describe, expect, it, vi } from 'vitest';

// The hourly chores of the server, each made to fail; nothing listens, nothing is copied, the base is in memory.
vi.mock('@hono/node-server', () => ({ serve: vi.fn() }));
vi.mock('./backup.ts', () => ({ backupIfMissing: vi.fn() }));
vi.mock('./db.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./db.ts')>();
  return { ...real, openDb: () => real.openDb(':memory:') };
});
vi.mock('./llm/keys.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm/keys.ts')>()),
  checkKeyExpiries: () => {
    throw new Error('échéance');
  },
}));
vi.mock('./contract/events.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./contract/events.ts')>()),
  pruneEvents: () => {
    throw new Error('purge');
  },
}));
vi.mock('./pina/agent.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pina/agent.ts')>()),
  expireCards: () => {
    throw new Error('fil');
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the server', () => {
  it('logs a failing hourly chore and runs it again the next hour', async () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await import('./main.ts');
    await vi.advanceTimersByTimeAsync(0);
    const seen = (what: string) =>
      errors.mock.calls.filter(([line]) => line === `${what} :`).map(([, e]) => e);
    for (const [what, message] of [
      ['Échéance des clés', 'échéance'],
      ['Purge des événements', 'purge'],
      ['Fil de Pina', 'fil'],
    ] as const)
      expect(seen(what)).toEqual([expect.objectContaining({ message })]);

    await vi.advanceTimersByTimeAsync(3_600_000);
    for (const what of ['Échéance des clés', 'Purge des événements', 'Fil de Pina'])
      expect(seen(what)).toHaveLength(2);
  });
});
