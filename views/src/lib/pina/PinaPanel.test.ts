import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import { ApiError } from '../client.ts';
import type { PinaCard, PinaThread } from '../types.ts';
import Toaster from '../ui/Toaster.svelte';
import { dismissAll } from '../ui/toasts.svelte.ts';
import PinaPanel from './PinaPanel.svelte';
import { clampSize, SIZE_KEY } from './pina.svelte.ts';

const card = (id: number, extra: Partial<PinaCard> = {}): PinaCard => ({
  id,
  day: '2026-11-02',
  turn: 1,
  createdAt: '2026-11-02T09:00:00.000Z',
  callId: `c${id}`,
  action: 'task.create',
  input: { title: 'Payer la taxe foncière', due: '2026-11-12' },
  effect: 'write',
  status: 'pending',
  result: null,
  error: null,
  inverse: null,
  decidedAt: null,
  edited: false,
  ...extra,
});

/** One request, Pina's reply, and her tool calls answered by `cards`. */
const thread = (cards: PinaCard[]): PinaThread => ({
  day: '2026-11-02',
  messages: [
    { id: 1, at: '2026-11-02T09:00:00.000Z', message: { role: 'user', text: 'Mets-moi une tâche.' } },
    {
      id: 2,
      at: '2026-11-02T09:00:02.000Z',
      message: {
        role: 'assistant',
        text: 'Je te la cale au 12, histoire d’avoir de la marge.',
        toolCalls: cards.map((c) => ({ id: c.callId, name: 'task_create', input: c.input })),
        turn: 1,
      },
    },
  ],
  cards,
  pending: cards.filter((c) => c.status === 'pending').length,
});

async function setup(t: PinaThread = thread([card(10)]), props: Record<string, unknown> = {}) {
  const fake = fakeClient();
  fake.client.pinaToday.mockResolvedValue(structuredClone(t));
  const user = userEvent.setup();
  const view = render(PinaPanel, { props: { client: fake.client, ...props } });
  await waitFor(() => expect(fake.client.pinaToday).toHaveBeenCalled());
  return { ...fake, user, view };
}

const panel = () => screen.queryByRole('dialog', { name: 'Pina' });

afterEach(() => {
  dismissAll();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('Pina', () => {
  it('the launcher carries the name and icon of the settings, « Agent » on a fresh install', async () => {
    const fake = fakeClient();
    fake.client.pinaToday.mockResolvedValue(thread([]));
    fake.client.getPinaSettings.mockResolvedValue({
      ...(await fake.client.getPinaSettings()),
      name: 'Agent',
      icon: 'moon',
    });
    render(PinaPanel, { props: { client: fake.client } });
    const launcher = await screen.findByRole('button', { name: /^Agent/ });
    expect(launcher.querySelector('svg')).toHaveClass('lucide-moon');
  });

  it('the launcher badge shows pending', async () => {
    await setup(thread([card(10), card(11)]));
    const launcher = await screen.findByRole('button', { name: /Pina/ });
    expect(await within(launcher).findByText('2')).toBeInTheDocument();
  });

  it('Ctrl J toggles the panel, also from a field', async () => {
    const { user } = await setup();
    const field = document.createElement('input');
    document.body.append(field);
    await user.keyboard('{Control>}j{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Pina' })).toBeInTheDocument();
    field.focus();
    await user.keyboard('{Control>}j{/Control}');
    await waitFor(() => expect(panel()).toBeNull());
    field.focus();
    await user.keyboard('{Control>}j{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Pina' })).toBeInTheDocument();
  });

  it('Ctrl Enter accepts the focused pending card, never in another field', async () => {
    const { client, user } = await setup(thread([card(10)]), { open: true });
    client.pinaDecide.mockResolvedValue({ ...thread([card(10, { status: 'done' })]), card: card(10) });
    const pending = await screen.findByRole('group', { name: /Créer une tâche/ });
    await user.click(screen.getByRole('textbox', { name: 'Demande à Pina' }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(client.pinaDecide).not.toHaveBeenCalled();
    pending.focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(client.pinaDecide).toHaveBeenCalledWith(10, 'accept', undefined);
  });

  it('Escape refuses the pending card', async () => {
    const { client, user } = await setup(thread([card(10)]), { open: true });
    client.pinaDecide.mockResolvedValue({ ...thread([card(10, { status: 'refused' })]), card: card(10) });
    (await screen.findByRole('group', { name: /Créer une tâche/ })).focus();
    await user.keyboard('{Escape}');
    expect(client.pinaDecide).toHaveBeenCalledWith(10, 'refuse', undefined);
  });

  it('the panel never goes below 340x420 nor beyond the viewport minus 24', () => {
    const viewport = { width: 1440, height: 900 };
    expect(clampSize({ width: 100, height: 100 }, viewport)).toEqual({ width: 340, height: 420 });
    expect(clampSize({ width: 5000, height: 5000 }, viewport)).toEqual({ width: 1416, height: 876 });
    expect(clampSize({ width: 500, height: 640 }, viewport)).toEqual({ width: 500, height: 640 });
  });

  it('keeps a size read back from the storage within the bounds', async () => {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: 10, height: 99999 }));
    await setup(thread([]), { open: true });
    const dialog = await screen.findByRole('dialog', { name: 'Pina' });
    expect(dialog.style.getPropertyValue('--largeur')).toBe('340px');
    expect(dialog.style.getPropertyValue('--hauteur')).toBe(`${window.innerHeight - 24}px`);
  });

  it('a failed card shows the server reason', async () => {
    await setup(thread([card(10, { status: 'failed', error: 'Liste de tâches introuvable' })]), {
      open: true,
    });
    expect(await screen.findByText('Liste de tâches introuvable')).toBeInTheDocument();
  });

  it('a 409 on a decision says why and reloads the thread', async () => {
    const { client, user } = await setup(thread([card(10)]), { open: true });
    render(Toaster);
    client.pinaDecide.mockRejectedValueOnce(new ApiError(409, 'Carte expirée'));
    await user.click(await screen.findByRole('button', { name: 'Valider' }));
    expect(await screen.findByText('Carte expirée')).toBeInTheDocument();
    expect(client.pinaToday).toHaveBeenCalledTimes(2);
  });

  it('cards of one turn get « Tout valider »', async () => {
    const { client, user } = await setup(thread([card(10), card(11)]), { open: true });
    client.pinaDecide.mockResolvedValue({ ...thread([]), card: card(10) });
    await user.click(await screen.findByRole('button', { name: 'Tout valider' }));
    await waitFor(() => expect(client.pinaDecide).toHaveBeenCalledTimes(2));
    expect(client.pinaDecide).toHaveBeenCalledWith(10, 'accept', undefined);
    expect(client.pinaDecide).toHaveBeenCalledWith(11, 'accept', undefined);
  });

  it('a deletion card is marked as such and says what it deletes', async () => {
    const t = thread([
      card(12, { action: 'event.delete', effect: 'delete', input: { calendarId: 'primary', id: 'e5' } }),
    ]);
    t.messages.push({
      id: 3,
      at: '2026-11-02T08:59:00.000Z',
      message: {
        role: 'tool',
        callId: 'c0',
        isError: false,
        content: JSON.stringify({
          items: [{ id: 'e5', title: 'Déjeuner avec Camille', start: '2026-11-04T12:30:00' }],
        }),
      },
    });
    await setup(t, { open: true });
    const deletion = await screen.findByRole('group', { name: /Suppression : Supprimer un événement/ });
    expect(within(deletion).getByText('Suppression')).toBeInTheDocument();
    expect(within(deletion).getByText('Déjeuner avec Camille')).toBeInTheDocument();
    expect(within(deletion).getByText(/12 h 30/)).toBeInTheDocument();
    expect(within(deletion).getByText('e5')).toBeInTheDocument();
  });

  it('« Tout valider » leaves the deletion card pending', async () => {
    const del = card(12, { action: 'task.delete', effect: 'delete', input: { listId: 'l', id: 't9' } });
    const { client, user } = await setup(thread([card(10), card(11), del]), { open: true });
    client.pinaDecide.mockResolvedValue({ ...thread([card(10), card(11), del]), card: card(10) });
    await user.click(await screen.findByRole('button', { name: 'Tout valider' }));
    await waitFor(() => expect(client.pinaDecide).toHaveBeenCalledTimes(2));
    expect(client.pinaDecide).not.toHaveBeenCalledWith(12, expect.anything(), undefined);
    expect(screen.getByText('2 actions proposées ensemble')).toBeInTheDocument();
  });

  it('a double click on « Tout valider » sends each card once', async () => {
    const { client, user } = await setup(thread([card(10), card(11)]), { open: true });
    let release = () => {};
    client.pinaDecide.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...thread([card(10), card(11)]), card: card(10) });
        }),
    );
    const all = await screen.findByRole('button', { name: 'Tout valider' });
    await user.dblClick(all);
    release();
    await waitFor(() => expect(client.pinaDecide).toHaveBeenCalledTimes(2));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(client.pinaDecide.mock.calls.map((c) => c[0])).toEqual([10, 11]);
  });

  it('after a decision the focus moves to the next pending card', async () => {
    const { client, user } = await setup(thread([card(10), card(11)]), { open: true });
    client.pinaDecide.mockResolvedValue({
      ...thread([card(10, { status: 'done' }), card(11)]),
      card: card(10),
    });
    (await screen.findAllByRole('button', { name: 'Valider' }))[0]!.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/Créer une tâche, en attente/));
  });

  it('Ctrl J does nothing while another dialog is open', async () => {
    const { user } = await setup();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    document.body.append(other);
    await user.keyboard('{Control>}j{/Control}');
    expect(panel()).toBeNull();
  });

  it('a done card offers Annuler only with an inverse', async () => {
    const { client, user } = await setup(
      thread([
        card(10, { status: 'done', inverse: { action: 'task.delete', input: {} } }),
        card(11, { status: 'done', input: { title: 'Sans retour' } }),
      ]),
      { open: true },
    );
    client.pinaUndo.mockResolvedValue({ card: card(10, { status: 'done', inverse: null }), result: {} });
    const undo = await screen.findAllByRole('button', { name: 'Annuler' });
    expect(undo).toHaveLength(1);
    await user.click(undo[0]!);
    expect(client.pinaUndo).toHaveBeenCalledWith(10);
  });

  it('a draft card opens the draft', async () => {
    const draft = card(12, {
      action: 'draft.create',
      status: 'done',
      input: { to: 'marie@example.com', subject: 'Re: Dîner samedi ?', text: 'Coucou Marie, ok pour 20 h.' },
      result: { id: 'd1', to: 'marie@example.com', subject: 'Re: Dîner samedi ?', text: 'Coucou Marie' },
    });
    let opened = '';
    const { user } = await setup(thread([draft]), { open: true, onopendraft: (id: string) => (opened = id) });
    await user.click(await screen.findByRole('button', { name: 'Ouvrir le brouillon' }));
    expect(opened).toBe('d1');
  });

  it('on a desktop the window stays over the draft; on a phone the sheet closes for the draft and the settings', async () => {
    const draft = card(12, {
      action: 'draft.create',
      status: 'done',
      input: { to: 'marie@example.com', subject: 'Re: Dîner samedi ?', text: 'Coucou' },
      result: { id: 'd1', to: 'marie@example.com', subject: 'Re: Dîner samedi ?', text: 'Coucou' },
    });
    const opened: string[] = [];
    const { user } = await setup(thread([draft]), {
      open: true,
      onopendraft: (id: string) => opened.push(id),
      onsettings: () => opened.push('reglages'),
    });
    await user.click(await screen.findByRole('button', { name: 'Ouvrir le brouillon' }));
    expect(opened).toEqual(['d1']);
    expect(panel()).toBeInTheDocument();

    // jsdom has no matchMedia: a phone width is stubbed.
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      await user.click(screen.getByRole('button', { name: 'Réglages' }));
      expect(opened).toEqual(['d1', 'reglages']);
      await waitFor(() => expect(panel()).not.toBeInTheDocument());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('↑ in the field recalls the last request, and a request carries the screen context', async () => {
    const { client, user } = await setup(thread([]), {
      open: true,
      context: { screen: 'mail', mailId: 'm1', label: 'Sujet 1' },
    });
    client.pinaAsk.mockResolvedValue(thread([]));
    const field = await screen.findByRole('textbox', { name: 'Demande à Pina' });
    await user.type(field, 'Résume ce mail{Enter}');
    expect(client.pinaAsk).toHaveBeenCalledWith('Résume ce mail', { screen: 'mail', mailId: 'm1' });
    await user.click(field);
    await user.keyboard('{ArrowUp}');
    expect(field).toHaveValue('Mets-moi une tâche.');
  });

  it('without a model, Pina says so and offers the settings; the launcher stays', async () => {
    let settings = 0;
    const t: PinaThread = {
      day: '2026-11-02',
      messages: [
        { id: 1, at: '2026-11-02T09:00:00.000Z', message: { role: 'user', text: 'Salut' } },
        {
          id: 2,
          at: '2026-11-02T09:00:00.000Z',
          message: {
            role: 'assistant',
            text: 'Aucun modèle choisi pour Pina : à régler dans Réglages › Fournisseurs d’IA.',
            toolCalls: [],
            turn: 1,
          },
        },
      ],
      cards: [],
      pending: 0,
    };
    const { user } = await setup(t, { open: true, onsettings: () => (settings += 1) });
    await user.click(await screen.findByRole('button', { name: 'Ouvrir les Réglages' }));
    expect(settings).toBe(1);
    await user.click(screen.getByRole('button', { name: /Réduire/ }));
    expect(await screen.findByRole('button', { name: /Pina/ })).toBeInTheDocument();
  });

  it('no "Anima" anywhere in the panel texts', async () => {
    await setup(
      thread([
        card(10),
        card(11, { status: 'done', inverse: {} }),
        card(12, { status: 'refused' }),
        card(13, { status: 'failed', error: 'Raison' }),
        card(14, { status: 'expired' }),
        card(15, {
          action: 'draft.create',
          status: 'done',
          input: { to: 'a@example.com', subject: 'S', text: 'T' },
        }),
      ]),
      { open: true },
    );
    await screen.findByRole('dialog', { name: 'Pina' });
    const texts = [
      document.body.textContent ?? '',
      ...[...document.querySelectorAll('[aria-label],[title],[placeholder]')].flatMap((e) => [
        e.getAttribute('aria-label') ?? '',
        e.getAttribute('title') ?? '',
        e.getAttribute('placeholder') ?? '',
      ]),
    ].join(' ');
    expect(texts).not.toMatch(/anima(?![a-z])/i);
    expect(texts).not.toMatch(/\btu\b|—/);
  });

  it('opening the panel never resizes nor re-lays out the app', async () => {
    const app = document.createElement('main');
    app.setAttribute('style', 'display: flex; width: 100%; height: 100%;');
    app.className = 'zone';
    document.body.append(app);
    const before = {
      style: app.getAttribute('style'),
      cls: app.className,
      body: document.body.getAttribute('style'),
    };
    const { user } = await setup();
    await user.keyboard('{Control>}j{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Pina' });
    expect(getComputedStyle(dialog).position).toBe('fixed');
    expect({
      style: app.getAttribute('style'),
      cls: app.className,
      body: document.body.getAttribute('style'),
    }).toEqual(before);
    expect(document.documentElement.getAttribute('style')).toBeNull();
  });
});
