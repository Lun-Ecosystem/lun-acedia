/** Drops `undefined` fields (zod optionals) so objects fit `exactOptionalPropertyTypes` types. */
export function stripUndefined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/**
 * Runs `run` now and then every `intervalMs`, never two at a time. Errors go to `onError` and the
 * loop goes on.
 */
export function startLoop(
  run: () => Promise<unknown>,
  opts: { intervalMs: number; onError?: (err: unknown) => void },
): { stop: () => void; runNow: () => Promise<void> } {
  let running: Promise<void> | undefined;
  const runNow = () => {
    running ??= (async () => {
      try {
        await run();
      } catch (err) {
        opts.onError?.(err);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const timer = setInterval(() => void runNow(), opts.intervalMs);
  timer.unref();
  void runNow();
  return { stop: () => clearInterval(timer), runNow };
}
