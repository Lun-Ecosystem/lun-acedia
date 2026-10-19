import { describe, expect, it, vi } from 'vitest';
import { clearToken, loadToken, pair, saveToken } from './session.ts';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('session', () => {
  it('pairs with the 6-digit code and returns the token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ token: 'tok-9', satellite: {} }), { status: 200 }),
    );
    expect(await pair('http://acedia.test/', ' 042517 ', { fetch })).toBe('tok-9');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://acedia.test/lun/v1/pair');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ code: '042517', client: "Lun'Acedia (app)" });
  });

  it('reports a refused code with the server message', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ error: 'Code expiré' }), { status: 401 }),
    );
    await expect(pair('', '000000', { fetch })).rejects.toThrow('Code expiré');
  });

  it('keeps the token across launches and forgets it on demand', () => {
    const storage = memory();
    expect(loadToken(storage)).toBeNull();
    saveToken(storage, 'tok-9');
    expect(loadToken(storage)).toBe('tok-9');
    clearToken(storage);
    expect(loadToken(storage)).toBeNull();
  });

  it('treats unavailable storage as not paired', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadToken(broken)).toBeNull();
  });
});
