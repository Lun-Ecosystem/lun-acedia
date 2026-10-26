// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@lun-ecosystem/lunacedia-views';
import App from './App.svelte';
import { createHttpClient } from './httpClient.ts';

const TOKEN_KEY = 'lunacedia.token';

/** A fake Lun'Acedia server: records each call as `METHOD /path`. */
function fakeServer({ keyRefused = false, startPaused = false } = {}) {
  const calls: string[] = [];
  let paused = startPaused;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    calls.push(key);
    switch (key) {
      case 'GET /api/labels':
        return json({ labels: [] });
      case 'GET /api/rules':
        return json({ rules: [] });
      case 'GET /api/settings':
        return json({ threshold: 100 });
      case 'GET /api/google/status':
        return json({ connected: false });
      case 'GET /api/clients':
        return json({
          clients: [
            {
              id: 1,
              name: "Lun'Acedia (app)",
              kind: 'device',
              createdAt: '2026-10-19T08:00:00.000Z',
              current: true,
            },
            {
              id: 2,
              name: 'Assistant local',
              kind: 'app',
              createdAt: '2026-10-20T09:30:00.000Z',
              current: false,
            },
          ],
        });
      case 'DELETE /api/clients/1':
        return new Response(null, { status: 204 });
      case 'GET /lun/v1/health':
        if (keyRefused)
          return json({ status: 'degraded', reason: 'anthropic-key', ...(paused ? { paused } : {}) });
        return json({ status: paused ? 'paused' : 'ok' });
      case 'GET /api/anthropic-key':
        return json({ state: keyRefused ? 'refused' : 'ok', last4: '7f3a' });
      case 'POST /lun/v1/resume':
        paused = false;
        return json({ status: 'ok' });
      case 'POST /lun/v1/pause':
        paused = true;
        return json({ status: 'paused' });
      case 'POST /lun/v1/pair':
        return json({ token: 'tok-2', satellite: {} });
      default:
        return json({ error: 'Introuvable' }, 404);
    }
  });
  vi.stubGlobal('fetch', fetch);
  return { calls };
}

const authorizeQuery = (redirect = 'http://127.0.0.1:53682/callback') =>
  `/?${new URLSearchParams({
    autoriser: '1',
    client: 'Assistant local',
    redirect_uri: redirect,
    state: 'state-1',
    code_challenge: 'challenge-1',
  })}`;

// jsdom has neither: Bits Command measures and scrolls its entries.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('revoking the current device clears the token and shows pairing, once', async () => {
    const { calls } = fakeServer();
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', '/?google=1');
    const user = userEvent.setup();
    render(App);

    await user.click(await screen.findByRole('link', { name: 'Appareils et applications' }));
    const self = (await screen.findByText('Ce navigateur')).closest('li')!;
    await user.click(within(self).getByRole('button', { name: 'Retirer' }));
    await user.click(await screen.findByRole('button', { name: 'Retirer ce navigateur' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Relier ce navigateur' }),
    ).toBeInTheDocument();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.at(-1)).toBe('DELETE /api/clients/1');
    expect(calls.filter((c) => c === 'DELETE /api/clients/1')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent("Ce navigateur n’a plus accès à Lun'Acedia.");
  });

  it('asks an unknown browser for a code, then resumes the authorization', async () => {
    fakeServer();
    history.replaceState(null, '', authorizeQuery());
    const user = userEvent.setup();
    render(App);

    expect(
      screen.getByText(
        "Lun'Acedia ne connaît pas ce navigateur. Saisir le code à 6 chiffres pour continuer.",
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code à 6 chiffres'), '042517');

    expect(
      await screen.findByRole('heading', { level: 1, name: "Assistant local demande l’accès à Lun'Acedia" }),
    ).toBeInTheDocument();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-2');
    expect(window.location.search).toContain('autoriser=1');
  });

  it('refuses a return address outside the loopback and leaves without the request', async () => {
    fakeServer();
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', authorizeQuery('http://localhost.evil.test/callback'));
    const user = userEvent.setup();
    render(App);

    expect(screen.getByRole('alert')).toHaveTextContent('Adresse de retour refusée');
    expect(screen.queryByRole('button', { name: 'Autoriser' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Ouvrir Lun'Acedia" }));
    expect(window.location.search).toBe('');
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
  });
});

describe('Shell', () => {
  it('pauses the sorting from the top bar, and the rail says so', async () => {
    const { calls } = fakeServer();
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    const user = userEvent.setup();
    render(App);
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    expect(within(rail).getByRole('link', { name: 'Réception' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Mettre le tri en pause' }));
    expect(calls).toContain('POST /lun/v1/pause');
    expect(await within(rail).findByText('Tri en pause')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reprendre le tri' })).toBeInTheDocument();
  });

  it('offers to resume a pause even while the key is refused', async () => {
    const { calls } = fakeServer({ keyRefused: true, startPaused: true });
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    const user = userEvent.setup();
    render(App);
    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    expect(await within(rail).findByText('Clé refusée · les règles continuent')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Reprendre le tri' }));
    expect(calls).toContain('POST /lun/v1/resume');
    expect(calls).not.toContain('POST /lun/v1/pause');
    expect(await screen.findByRole('button', { name: 'Mettre le tri en pause' })).toBeInTheDocument();
  });

  it('opens the palette with Ctrl K and goes to a screen', async () => {
    fakeServer();
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    const user = userEvent.setup();
    render(App);
    await screen.findByRole('navigation', { name: 'Sections' });
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Palette de commandes' });
    expect(within(palette).getByText('Nouveau message')).toBeInTheDocument();
    await user.click(within(palette).getByText('Journal'));
    expect(window.location.hash).toBe('#/journal');
  });
});

describe('Settings without onSelfRevoked', () => {
  it('hands a self-revocation to the client’s 401 handling, once', async () => {
    const { calls } = fakeServer();
    const onUnauthorized = vi.fn();
    const client = createHttpClient('http://acedia.test', 'tok-1', { onUnauthorized });
    const user = userEvent.setup();
    render(Settings, { props: { client } });

    await user.click(await screen.findByRole('link', { name: 'Appareils et applications' }));
    const self = (await screen.findByText('Ce navigateur')).closest('li')!;
    // From now on the token is dead.
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ error: 'Jeton absent, invalide ou révoqué' }), { status: 401 });
    });
    await user.click(within(self).getByRole('button', { name: 'Retirer' }));
    await user.click(await screen.findByRole('button', { name: 'Retirer ce navigateur' }));

    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(calls.slice(-2)).toEqual(['DELETE /api/clients/1', 'GET /api/clients']);
  });
});
