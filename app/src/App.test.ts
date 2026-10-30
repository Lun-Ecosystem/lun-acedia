// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '@lun-ecosystem/lunacedia-views';
import App from './App.svelte';
import { createHttpClient } from './httpClient.ts';

const TOKEN_KEY = 'lunacedia.token';

/** A fake Lun'Acedia server: records each call as `METHOD /path`. */
/** Today's thread of Pina with one reply drafted (`d1`), done. */
const DRAFT_THREAD = {
  day: '2026-11-02',
  messages: [
    { id: 1, at: '2026-11-02T09:00:00.000Z', message: { role: 'user', text: 'Réponds-lui oui.' } },
    {
      id: 2,
      at: '2026-11-02T09:00:02.000Z',
      message: {
        role: 'assistant',
        text: 'Brouillon prêt.',
        toolCalls: [{ id: 'c1', name: 'draft_create', input: {} }],
        turn: 1,
      },
    },
  ],
  cards: [
    {
      id: 12,
      day: '2026-11-02',
      turn: 1,
      createdAt: '2026-11-02T09:00:01.000Z',
      callId: 'c1',
      action: 'draft.create',
      input: { to: 'marie@example.com', subject: 'Re: Dîner samedi ?', text: 'Coucou Marie' },
      effect: 'write',
      status: 'done',
      result: { id: 'd1', to: 'marie@example.com', subject: 'Re: Dîner samedi ?', text: 'Coucou Marie' },
      error: null,
      inverse: null,
      decidedAt: '2026-11-02T09:00:02.000Z',
      edited: false,
    },
  ],
  pending: 0,
};

const MAIL_42 = {
  id: '42',
  threadId: 't42',
  from: { name: 'Marie', email: 'marie@example.com' },
  subject: 'Dîner samedi ?',
  snippet: 'Tu viens ?',
  date: '2026-11-02T08:00:00.000Z',
  unread: false,
  labels: [],
};

function fakeServer({ keyRefused = false, startPaused = false, draft = false, mails = false } = {}) {
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
      case 'GET /api/llm/providers':
        return json({
          providers: [
            { id: 'anthropic', label: 'Anthropic', state: keyRefused ? 'refused' : 'ok', last4: '7f3a' },
          ],
        });
      case 'GET /api/llm/models':
        return json({ models: [] });
      case 'GET /api/llm/choice':
        return json({ triage: null, pina: null });
      case 'POST /lun/v1/resume':
        paused = false;
        return json({ status: 'ok' });
      case 'POST /lun/v1/pause':
        paused = true;
        return json({ status: 'paused' });
      case 'GET /api/pina/today':
        return json(draft ? DRAFT_THREAD : { day: '2026-11-02', messages: [], cards: [], pending: 0 });
      case 'GET /api/drafts/d1':
        return json({
          id: 'd1',
          to: 'marie@example.com',
          subject: 'Re: Dîner samedi ?',
          text: 'Coucou Marie',
        });
      case 'GET /api/mail':
        return json({ items: mails ? [MAIL_42] : [] });
      case 'GET /api/mail/43':
        return json({
          ...MAIL_42,
          id: '43',
          subject: 'Hors boîte',
          to: 'moi@example.com',
          html: '<p>Rangé ailleurs</p>',
          attachments: [],
        });
      case 'GET /api/mail/42':
        return json({ ...MAIL_42, to: 'moi@example.com', html: '<p>Tu viens ?</p>', attachments: [] });
      case 'GET /api/send-as':
        return json({ addresses: [{ email: 'moi@example.com', primary: true }], default: 'moi@example.com' });
      case 'GET /api/pina/days':
        return json({ days: [] });
      case 'GET /api/pina/settings':
        return json({
          mode: 'validate',
          instructions: '',
          retentionDays: 30,
          dailyCapUsd: 1,
          name: 'Pina',
          icon: 'sparkles',
          tone: 'chaleureux',
          persona: '',
        });
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
  it('Pina overlays the shell: opening her window never changes the main area', async () => {
    fakeServer();
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    const user = userEvent.setup();
    const { container } = render(App);
    const main = await waitFor(() => container.querySelector('main')!);
    const zone = main.parentElement!;
    const look = () => [
      main.className,
      main.getAttribute('style'),
      zone.className,
      zone.getAttribute('style'),
    ];
    const before = look();
    await user.keyboard('{Control>}j{/Control}');
    const pina = await screen.findByRole('dialog', { name: 'Pina' });
    expect(main.contains(pina)).toBe(false);
    expect(look()).toEqual(before);
  });

  it('« Ouvrir le brouillon » opens the composer on that draft, under Pina’s window, layout unchanged', async () => {
    fakeServer({ draft: true });
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', '/#/agenda');
    const user = userEvent.setup();
    const { container } = render(App);
    const main = await waitFor(() => container.querySelector('main')!);
    const zone = main.parentElement!;
    const look = () => [
      main.className,
      main.getAttribute('style'),
      zone.className,
      zone.getAttribute('style'),
    ];
    const before = look();
    await user.keyboard('{Control>}j{/Control}');
    const pina = await screen.findByRole('dialog', { name: 'Pina' });
    await user.click(await within(pina).findByRole('button', { name: 'Ouvrir le brouillon' }));

    const composer = await screen.findByRole('form', { name: 'Brouillon' });
    expect(within(composer).getByText('Brouillon préparé par Pina.')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(composer).getByRole('textbox', { name: 'Message' })).toHaveValue('Coucou Marie'),
    );
    // On a desktop the window stays open, over the composer, which keeps its place.
    expect(screen.getByRole('dialog', { name: 'Pina' })).toBeInTheDocument();
    expect(main.contains(screen.getByRole('dialog', { name: 'Pina' }))).toBe(false);
    expect(main.contains(composer)).toBe(true);
    expect(look()).toEqual(before);
  });

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
    expect(
      await within(rail).findByText('Clé Anthropic refusée · les règles continuent'),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Reprendre le tri' }));
    expect(calls).toContain('POST /lun/v1/resume');
    expect(calls).not.toContain('POST /lun/v1/pause');
    expect(await screen.findByRole('button', { name: 'Mettre le tri en pause' })).toBeInTheDocument();
  });

  it('#/mail/42 opens the mail 42', async () => {
    const { calls } = fakeServer({ mails: true });
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', '/#/mail/42');
    render(App);
    await waitFor(() => expect(calls).toContain('GET /api/mail/42'));
  });

  it('#/mail/inconnu opens the box', async () => {
    const { calls } = fakeServer({ mails: true });
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', '/#/mail/inconnu');
    render(App);
    await waitFor(() => expect(calls).toContain('GET /api/mail'));
    // Not in the list: it is asked by its id, fails quietly, and the box shows alone.
    await waitFor(() => expect(calls).toContain('GET /api/mail/inconnu'));
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('#/mail/43 opens a mail absent from the loaded list', async () => {
    const { calls } = fakeServer({ mails: true });
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', '/#/mail/43');
    render(App);
    await waitFor(() => expect(calls).toContain('GET /api/mail/43'));
    expect(await screen.findAllByText('Hors boîte')).not.toHaveLength(0);
  });

  it('#/mail/42 then #/mail/43 while the mail screen is open opens the second mail', async () => {
    const { calls } = fakeServer({ mails: true });
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', '/#/mail/42');
    render(App);
    await waitFor(() => expect(calls).toContain('GET /api/mail/42'));
    window.location.hash = '#/mail/43';
    await waitFor(() => expect(calls).toContain('GET /api/mail/43'));
    // The same address again, after another hash, opens it again.
    window.location.hash = '#/mail';
    window.location.hash = '#/mail/43';
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/mail/43')).toHaveLength(2));
  });

  it('a #/mail/<id> hashchange opens that mail too', async () => {
    const { calls } = fakeServer({ mails: true });
    localStorage.setItem(TOKEN_KEY, 'tok-1');
    history.replaceState(null, '', '/#/agenda');
    render(App);
    await screen.findByRole('navigation', { name: 'Sections' });
    window.location.hash = '#/mail/42';
    await waitFor(() => expect(calls).toContain('GET /api/mail/42'));
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
