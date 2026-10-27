import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../client.ts';
import { fakeClient, PROVIDERS } from '../../testing/fake-client.ts';
import type { ProviderView } from '../types.ts';
import Providers from './Providers.svelte';

const NEW_KEY = 'sk-ant-test-000000000000c0de';

function open(providers: ProviderView[] | null = PROVIDERS.map((p) => ({ ...p }))) {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(Providers, { props: { client, providers } });
  const card = (name: string) => screen.getByRole('region', { name });
  return { client, user, card };
}

async function replace(user: ReturnType<typeof userEvent.setup>, card: HTMLElement, name = 'Remplacer…') {
  await user.click(within(card).getByRole('button', { name }));
  return screen.findByRole('dialog');
}

describe('Providers', () => {
  it('Providers lists the five providers with their state and last4 only', () => {
    const { card } = open([
      ...PROVIDERS.slice(0, 3),
      { id: 'mistral', label: 'Mistral', state: 'refused', last4: '1111', source: 'saved' },
      { id: 'custom', label: 'Point d’accès compatible', state: 'credit', last4: '2222', source: 'saved' },
    ]);
    const anthropic = card('Anthropic');
    expect(within(anthropic).getByText('En service')).toBeInTheDocument();
    expect(within(anthropic).getByText('7f3a')).toBeInTheDocument();
    expect(within(anthropic).getByText(/^31 déc. 2026 · /)).toBeInTheDocument();
    expect(within(card('OpenAI')).getByText('Clé du fichier .env')).toBeInTheDocument();
    expect(within(card('OpenAI')).queryByRole('button', { name: 'Retirer' })).not.toBeInTheDocument();
    expect(
      within(card('Google Gemini')).getByRole('button', { name: 'Ajouter une clé' }),
    ).toBeInTheDocument();
    expect(within(card('Google Gemini')).queryByText(/Se termine par/)).not.toBeInTheDocument();
    expect(within(card('Mistral')).getByText('Refusée')).toBeInTheDocument();
    expect(within(card('Point d’accès compatible')).getByText('Crédit épuisé')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sk-/);
  });

  it('the declared expiry says the days left, and changes without the key', async () => {
    const { client } = fakeClient();
    const user = userEvent.setup();
    render(Providers, {
      props: { client, providers: PROVIDERS.map((p) => ({ ...p })), now: new Date('2026-12-20T09:00:00Z') },
    });
    const anthropic = screen.getByRole('region', { name: 'Anthropic' });
    const line = within(anthropic).getByText('31 déc. 2026 · dans 11 jours');
    expect(line).toHaveAttribute('data-ton', 'attention');
    // A key from .env declares its date in .env: nothing to change here.
    expect(
      within(screen.getByRole('region', { name: 'OpenAI' })).queryByRole('button', {
        name: 'Modifier l’échéance',
      }),
    ).not.toBeInTheDocument();

    client.setProviderExpiry.mockResolvedValueOnce({ ...PROVIDERS[0]!, expires: '2027-08-11' });
    const action = within(anthropic).getByRole('button', { name: 'Modifier l’échéance' });
    await user.click(action);
    const window = await screen.findByRole('dialog', { name: 'Modifier l’échéance' });
    const date = within(window).getByLabelText('Échéance');
    expect(date).toHaveValue('2026-12-31');
    await user.clear(date);
    await user.type(date, '2027-08-11');
    await user.click(within(window).getByRole('button', { name: 'Enregistrer' }));
    expect(client.setProviderExpiry).toHaveBeenCalledWith('anthropic', '2027-08-11');
    expect(client.saveProviderKey).not.toHaveBeenCalled();
    const after = await within(anthropic).findByText('11 août 2027 · dans 234 jours');
    expect(after).toHaveAttribute('data-ton', 'neutre');
    await waitFor(() => expect(action).toHaveFocus());

    client.setProviderExpiry.mockResolvedValueOnce({
      id: 'anthropic',
      label: 'Anthropic',
      state: 'ok',
      last4: '7f3a',
      source: 'saved',
    });
    await user.click(action);
    await user.click(await screen.findByRole('button', { name: 'Sans échéance' }));
    expect(client.setProviderExpiry).toHaveBeenLastCalledWith('anthropic', null);
    expect(await within(anthropic).findByText('Aucune')).toBeInTheDocument();
  });

  it('a date already past shows in danger', () => {
    const { client } = fakeClient();
    render(Providers, {
      props: { client, providers: PROVIDERS.map((p) => ({ ...p })), now: new Date('2027-01-07T09:00:00Z') },
    });
    const line = within(screen.getByRole('region', { name: 'Anthropic' })).getByText(
      '31 déc. 2026 · dépassée depuis 7 jours',
    );
    expect(line).toHaveAttribute('data-ton', 'danger');
  });

  it('removing a key gives the focus back to its card', async () => {
    const { client, user, card } = open();
    client.removeProviderKey.mockResolvedValueOnce({ id: 'anthropic', label: 'Anthropic', state: 'absent' });
    await user.click(within(card('Anthropic')).getByRole('button', { name: 'Retirer' }));
    await user.click(await screen.findByRole('button', { name: 'Retirer la clé' }));
    const add = await within(card('Anthropic')).findByRole('button', { name: 'Ajouter une clé' });
    await waitFor(() => expect(add).toHaveFocus());
  });

  it('the address typed stays while the providers change, window open', async () => {
    const { client } = fakeClient();
    const user = userEvent.setup();
    const view = render(Providers, { props: { client, providers: PROVIDERS.map((p) => ({ ...p })) } });
    await user.click(
      within(screen.getByRole('region', { name: 'Point d’accès compatible' })).getByRole('button', {
        name: 'Ajouter une clé',
      }),
    );
    const window = await screen.findByRole('dialog');
    await user.type(within(window).getByLabelText('Adresse'), 'http://localhost:11434/v1');
    // A refresh from elsewhere (another key saved, the keys read again).
    await view.rerender({ providers: PROVIDERS.map((p) => ({ ...p })) });
    expect(within(window).getByLabelText('Adresse')).toHaveValue('http://localhost:11434/v1');
  });

  it('custom shows a base URL field', async () => {
    const { client, user, card } = open();
    client.saveProviderKey.mockResolvedValueOnce({
      id: 'custom',
      label: 'Point d’accès compatible',
      state: 'ok',
      last4: 'c0de',
      source: 'saved',
      baseUrl: 'http://localhost:11434/v1',
    });
    const window = await replace(user, card('Point d’accès compatible'), 'Ajouter une clé');
    await user.type(within(window).getByLabelText('Nouvelle clé'), NEW_KEY);
    const save = within(window).getByRole('button', { name: 'Vérifier et enregistrer' });
    // Without an address, the custom endpoint cannot serve.
    expect(save).toBeDisabled();
    await user.type(within(window).getByLabelText('Adresse'), 'http://localhost:11434/v1');
    await user.click(save);
    expect(client.saveProviderKey).toHaveBeenCalledWith('custom', {
      key: NEW_KEY,
      baseUrl: 'http://localhost:11434/v1',
    });
    const custom = card('Point d’accès compatible');
    expect(await within(custom).findByText('http://localhost:11434/v1')).toBeInTheDocument();
    expect(within(custom).getByText('c0de')).toBeInTheDocument();
  });

  it('the other providers ask for no address', async () => {
    const { user, card } = open();
    const window = await replace(user, card('Google Gemini'), 'Ajouter une clé');
    expect(within(window).queryByLabelText('Adresse')).not.toBeInTheDocument();
  });

  it('replaces a key in a window, with its expiry, and shows the new state', async () => {
    const { client, user, card } = open();
    client.saveProviderKey.mockResolvedValueOnce({
      id: 'anthropic',
      label: 'Anthropic',
      state: 'ok',
      last4: 'c0de',
      expires: '2027-03-01',
      source: 'saved',
    });
    const window = await replace(user, card('Anthropic'));
    const field = within(window).getByLabelText('Nouvelle clé');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    await user.type(field, NEW_KEY);
    await user.type(within(window).getByLabelText('Échéance'), '2027-03-01');
    await user.click(within(window).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(client.saveProviderKey).toHaveBeenCalledWith('anthropic', { key: NEW_KEY, expires: '2027-03-01' });
    expect(await within(card('Anthropic')).findByText('c0de')).toBeInTheDocument();
    expect(within(card('Anthropic')).getByText(/^1 mars 2027 · /)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a refused key keeps the window open with the reason, and the old state', async () => {
    const { client, user, card } = open();
    client.saveProviderKey.mockRejectedValueOnce(
      new ApiError(400, 'Clé refusée par Anthropic, rien n’a changé'),
    );
    const window = await replace(user, card('Anthropic'));
    await user.type(within(window).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(within(window).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(await within(window).findByText('Clé refusée par Anthropic, rien n’a changé')).toBeInTheDocument();
    expect(within(card('Anthropic')).getByText('7f3a')).toBeInTheDocument();
  });

  it('the window stays open while the key is being checked', async () => {
    const { client, user, card } = open();
    client.saveProviderKey.mockReturnValueOnce(new Promise(() => {}));
    const window = await replace(user, card('Anthropic'));
    await user.type(within(window).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(within(window).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(within(window).getByText('Vérification auprès d’Anthropic…')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('removing a key goes through a confirmation', async () => {
    const { client, user, card } = open();
    await user.click(within(card('Anthropic')).getByRole('button', { name: 'Retirer' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveAccessibleName('Retirer la clé Anthropic ?');
    expect(client.removeProviderKey).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Retirer la clé' }));
    expect(client.removeProviderKey).toHaveBeenCalledWith('anthropic');
    expect(
      await within(card('Anthropic')).findByRole('button', { name: 'Ajouter une clé' }),
    ).toBeInTheDocument();
  });

  it('keys that cannot be read show a card to retry', async () => {
    const { client, user, card } = open(null);
    const unknown = card('Fournisseurs d’IA');
    expect(within(unknown).getByText('État des clés inconnu')).toBeInTheDocument();
    await user.click(within(unknown).getByRole('button', { name: 'Réessayer' }));
    expect(client.getProviders).toHaveBeenCalled();
    expect(await screen.findByRole('region', { name: 'Anthropic' })).toBeInTheDocument();
  });
});
