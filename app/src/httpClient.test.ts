import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, UnauthorizedError } from './httpClient.ts';

const BASE = 'http://acedia.test';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createHttpClient', () => {
  it('lists the inbox with the bearer token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ items: [], nextCursor: null }));
    const client = createHttpClient(BASE, 'tok-1', { fetch });
    await client.listMail('inbox');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/mail?view=inbox`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok-1');
  });

  it('throws UnauthorizedError on 401 and reports it', async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ error: 'Jeton invalide' }, 401));
    const client = createHttpClient(BASE, 'old', { fetch, onUnauthorized });
    await expect(client.listMail('inbox')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('receives a streamed event and stops when unsubscribed', async () => {
    const event = {
      id: '7',
      type: 'mail.triaged',
      importance: 'info',
      title: 'Rangé',
      at: '2026-10-19T08:00:00Z',
    };
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`id: 7\ndata: ${JSON.stringify(event)}\n\n`));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createHttpClient(BASE, 'tok-1', { fetch });
    const received = await new Promise<unknown>((resolve) => {
      const stop = client.subscribe((e) => {
        stop();
        resolve(e);
      });
    });
    expect(received).toEqual(event);
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}/lun/v1/events`);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer tok-1');
    expect(signal?.aborted).toBe(true);
  });
});
