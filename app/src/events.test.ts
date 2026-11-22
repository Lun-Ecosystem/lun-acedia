import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from './httpClient.ts';

/*
 * One tab, one stream. The client opens a single connection to `/lun/v1/events` however many
 * listeners subscribe, and each listener receives what it received on a stream of its own: the same
 * events, in the same order. A browser holds six connections per address, all tabs together.
 */

const BASE = 'http://acedia.test';
const RECONNECT_MS = 3000;

const ev = (id: string, type = 'mail.triaged') => ({
  id,
  type,
  importance: 'info',
  title: 'Rangé',
  at: '2026-10-19T08:00:00Z',
});

/** A fake events endpoint: records each connection, lets the test push frames or cut it. */
function fakeStream(status = 200) {
  interface Conn {
    headers: Headers;
    signal: AbortSignal | undefined;
    push(e: { id: string }): void;
    cut(): void;
  }
  const conns: Conn[] = [];
  let reply = status;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (reply !== 200) return new Response('{"error":"Jeton invalide"}', { status: reply });
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    const signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => ctl.error(new Error('aborted')));
    conns.push({
      headers: new Headers(init?.headers),
      signal,
      push: (e) => {
        // A connection already closed by the client takes nothing: the test goes on, the listener gets nothing.
        try {
          ctl.enqueue(
            new TextEncoder().encode(`id: ${e.id}
data: ${JSON.stringify(e)}

`),
          );
        } catch {
          // closed: nothing to deliver
        }
      },
      cut: () => ctl.close(),
    });
    return new Response(body, { status: 200 });
  });
  return {
    fetch,
    conns,
    setStatus: (s: number) => (reply = s),
    open: () => conns.filter((c) => !c.signal?.aborted).length,
  };
}

/** Lets the stream's promise chain run (timers are faked, immediates are not). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one stream per client', () => {
  it('opens nothing before the first subscriber', async () => {
    const s = fakeStream();
    createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    await settle();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('opens a single connection however many listeners subscribe', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    client.subscribe(() => {});
    client.subscribe(() => {});
    client.subscribe(() => {});
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.fetch.mock.calls[0]![0]).toBe(`${BASE}/lun/v1/events`);
    expect(s.conns[0]!.headers.get('authorization')).toBe('Bearer tok-1');
    // A listener arriving later joins the open connection.
    client.subscribe(() => {});
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it('closes the connection when the last listener leaves, not before', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const stopA = client.subscribe(() => {});
    const stopB = client.subscribe(() => {});
    await settle();
    stopA();
    await settle();
    expect(s.open()).toBe(1);
    stopB();
    await settle();
    expect(s.open()).toBe(0);
    expect(s.conns[0]!.signal?.aborted).toBe(true);
    // Nothing reconnects afterwards.
    await vi.advanceTimersByTimeAsync(RECONNECT_MS * 3);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it('stopping twice is harmless and does not cut the others', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const got: string[] = [];
    const stopA = client.subscribe(() => {});
    client.subscribe((e) => got.push(e.id));
    await settle();
    stopA();
    stopA();
    await settle();
    s.conns[0]!.push(ev('1'));
    await settle();
    expect(got).toEqual(['1']);
    expect(s.open()).toBe(1);
  });

  it('keeps the connection when a screen leaves and the next one subscribes at once', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const got: string[] = [];
    const stop = client.subscribe(() => {});
    await settle();
    // The screen changes: its teardown and the next screen's setup run in the same tick.
    stop();
    client.subscribe((e) => got.push(e.id));
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.conns[0]!.signal?.aborted).toBe(false);
    s.conns[0]!.push(ev('1'));
    await settle();
    expect(got).toEqual(['1']);
  });

  it('opens a new connection for a listener that comes after the stream was closed', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    client.subscribe(() => {})();
    await settle();
    const got: string[] = [];
    client.subscribe((e) => got.push(e.id));
    await settle();
    expect(s.open()).toBe(1);
    s.conns.at(-1)!.push(ev('9'));
    await settle();
    expect(got).toEqual(['9']);
  });
});

describe('each listener receives what it received before', () => {
  it('gives every listener the same events in the same order', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const a: string[] = [];
    const b: string[] = [];
    client.subscribe((e) => a.push(e.id));
    client.subscribe((e) => b.push(e.id));
    await settle();
    for (const id of ['1', '2', '3']) s.conns[0]!.push(ev(id));
    await settle();
    expect(a).toEqual(['1', '2', '3']);
    expect(b).toEqual(['1', '2', '3']);
  });

  it('lets each listener filter by type on its own', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const mail: string[] = [];
    const agenda: string[] = [];
    client.subscribe((e) => e.type.startsWith('mail.') && mail.push(e.type));
    client.subscribe((e) => e.type.startsWith('agenda.') && agenda.push(e.type));
    await settle();
    s.conns[0]!.push(ev('1', 'mail.filed'));
    s.conns[0]!.push(ev('2', 'agenda.overlap'));
    await settle();
    expect(mail).toEqual(['mail.filed']);
    expect(agenda).toEqual(['agenda.overlap']);
  });

  it('gives a listener nothing after it stopped, and the others keep theirs', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const a: string[] = [];
    const b: string[] = [];
    const stopA = client.subscribe((e) => a.push(e.id));
    client.subscribe((e) => b.push(e.id));
    await settle();
    s.conns[0]!.push(ev('1'));
    await settle();
    stopA();
    s.conns[0]!.push(ev('2'));
    await settle();
    expect(a).toEqual(['1']);
    expect(b).toEqual(['1', '2']);
  });

  it('does not give a late listener what came before it subscribed', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    client.subscribe(() => {});
    await settle();
    s.conns[0]!.push(ev('1'));
    await settle();
    const late: string[] = [];
    client.subscribe((e) => late.push(e.id));
    s.conns[0]!.push(ev('2'));
    await settle();
    expect(late).toEqual(['2']);
  });

  it('a listener that throws does not deprive the others, nor stop the stream', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const after: string[] = [];
    client.subscribe(() => {
      throw new Error('écran cassé');
    });
    client.subscribe((e) => after.push(e.id));
    await settle();
    s.conns[0]!.push(ev('1'));
    s.conns[0]!.push(ev('2'));
    await settle();
    expect(after).toEqual(['1', '2']);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.open()).toBe(1);
  });

  it('subscribing and stopping from inside a listener breaks nothing', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const first: string[] = [];
    const second: string[] = [];
    const joined: string[] = [];
    let stopFirst = () => {};
    stopFirst = client.subscribe((e) => {
      first.push(e.id);
      if (e.id === '1') {
        client.subscribe((n) => joined.push(n.id));
        stopFirst();
      }
    });
    client.subscribe((e) => second.push(e.id));
    await settle();
    s.conns[0]!.push(ev('1'));
    s.conns[0]!.push(ev('2'));
    await settle();
    // The event in flight reaches each listener that was there once; none is skipped or doubled.
    expect(first).toEqual(['1']);
    expect(second).toEqual(['1', '2']);
    expect(joined).toEqual(['2']);
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the connection after a cut', () => {
  it('reconnects once for all listeners, after the same delay, from the last event seen', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const a: string[] = [];
    const b: string[] = [];
    client.subscribe((e) => a.push(e.id));
    client.subscribe((e) => b.push(e.id));
    await settle();
    s.conns[0]!.push(ev('7'));
    await settle();
    s.conns[0]!.cut();
    await settle();
    await vi.advanceTimersByTimeAsync(RECONNECT_MS - 1);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.conns[1]!.headers.get('last-event-id')).toBe('7');
    expect(s.conns[1]!.headers.get('authorization')).toBe('Bearer tok-1');
    s.conns[1]!.push(ev('8'));
    await settle();
    expect(a).toEqual(['7', '8']);
    expect(b).toEqual(['7', '8']);
  });

  it('does not reconnect when the last listener left during the wait', async () => {
    const s = fakeStream();
    const client = createHttpClient(BASE, 'tok-1', { fetch: s.fetch });
    const stop = client.subscribe(() => {});
    await settle();
    s.conns[0]!.cut();
    await settle();
    stop();
    await vi.advanceTimersByTimeAsync(RECONNECT_MS * 2);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it('a refused token keeps its behaviour: the app is told, the stream tries again every 3 s, once', async () => {
    const s = fakeStream(401);
    const onUnauthorized = vi.fn();
    const client = createHttpClient(BASE, 'old', { fetch: s.fetch, onUnauthorized });
    client.subscribe(() => {});
    client.subscribe(() => {});
    client.subscribe(() => {});
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it('comes back for every listener once the server accepts the token again', async () => {
    const s = fakeStream(401);
    const client = createHttpClient(BASE, 'tok', { fetch: s.fetch });
    const a: string[] = [];
    const b: string[] = [];
    client.subscribe((e) => a.push(e.id));
    client.subscribe((e) => b.push(e.id));
    await settle();
    s.setStatus(200);
    await vi.advanceTimersByTimeAsync(RECONNECT_MS);
    await settle();
    s.conns[0]!.push(ev('1'));
    await settle();
    expect(s.open()).toBe(1);
    expect(a).toEqual(['1']);
    expect(b).toEqual(['1']);
  });
});
