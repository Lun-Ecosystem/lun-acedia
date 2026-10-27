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

  it('lists, revokes and authorizes clients on their routes', async () => {
    const clients = [
      { id: 2, name: 'Assistant local', kind: 'app', createdAt: '2026-10-20T09:30:00Z', current: false },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).endsWith('/api/clients')) return json({ clients });
      if (String(url).endsWith('/api/authorizations'))
        return json({ redirect: 'http://127.0.0.1:5/cb?code=c' });
      return new Response(null, { status: 204 });
    });
    const client = createHttpClient(BASE, 'tok-1', { fetch });
    expect(await client.listClients()).toEqual(clients);
    await client.revokeClient(2);
    const req = {
      client: 'Assistant local',
      redirect_uri: 'http://127.0.0.1:5/cb',
      state: 's',
      code_challenge: 'c',
      decision: 'allow' as const,
    };
    expect(await client.authorize(req)).toEqual({ redirect: 'http://127.0.0.1:5/cb?code=c' });
    const calls = fetch.mock.calls.map(([url, init]) => [init?.method, String(url)]);
    expect(calls).toEqual([
      ['GET', `${BASE}/api/clients`],
      ['DELETE', `${BASE}/api/clients/2`],
      ['POST', `${BASE}/api/authorizations`],
    ]);
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual(req);
  });

  it('reads, replaces and removes the provider keys, and chooses a model, on the /api/llm routes', async () => {
    const view = {
      id: 'custom',
      label: 'Point d’accès compatible',
      state: 'ok',
      last4: 'c0de',
      source: 'saved',
    };
    const models = [{ provider: 'openai', id: 'gpt-6-luna', label: 'GPT-6 Luna', tools: true, tier: '€' }];
    const choice = { triage: null, pina: null };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/llm/providers') return json({ providers: [view] });
      if (path === '/api/llm/models') return json({ models });
      if (path === '/api/llm/choice') return json(choice);
      return json(view);
    });
    const client = createHttpClient(BASE, 'tok-1', { fetch });
    expect(await client.getProviders()).toEqual([view]);
    const key = { key: 'sk-test-c0de', expires: '2027-03-01', baseUrl: 'http://localhost:11434/v1' };
    expect(await client.saveProviderKey('custom', key)).toEqual(view);
    await client.removeProviderKey('custom');
    expect(await client.getModels('pina')).toEqual(models);
    expect(await client.getModelChoice()).toEqual(choice);
    await client.setModelChoice('triage', 'openai', 'gpt-6-luna');
    const calls = fetch.mock.calls.map(([url, init]) => [init?.method, String(url)]);
    expect(calls).toEqual([
      ['GET', `${BASE}/api/llm/providers`],
      ['PUT', `${BASE}/api/llm/providers/custom/key`],
      ['DELETE', `${BASE}/api/llm/providers/custom/key`],
      ['GET', `${BASE}/api/llm/models?use=pina`],
      ['GET', `${BASE}/api/llm/choice`],
      ['PUT', `${BASE}/api/llm/choice`],
    ]);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual(key);
    expect(JSON.parse(String(fetch.mock.calls[5]![1]?.body))).toEqual({
      use: 'triage',
      provider: 'openai',
      model: 'gpt-6-luna',
    });
  });

  it('reports a refused key with the server message', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ error: 'Anthropic injoignable, rien n’a changé' }, 502),
    );
    const client = createHttpClient(BASE, 'tok-1', { fetch });
    await expect(client.saveProviderKey('anthropic', { key: 'sk-ant-test-c0de' })).rejects.toMatchObject({
      status: 502,
      message: 'Anthropic injoignable, rien n’a changé',
    });
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
