import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError, type AnthropicKeyStatus } from '../client.ts';
import { fakeClient } from '../../testing/fake-client.ts';
import AnthropicKey from './AnthropicKey.svelte';

const NEW_KEY = 'sk-ant-test-000000000000c0de';
const OK: AnthropicKeyStatus = { state: 'ok', last4: '7f3a', expires: '2026-12-31', source: 'saved' };

function open(status: AnthropicKeyStatus = OK) {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(AnthropicKey, { props: { client, status } });
  const card = screen.getByRole('region', { name: 'Clé Anthropic' });
  return { client, user, card };
}

async function replace(user: ReturnType<typeof userEvent.setup>, card: HTMLElement, name = 'Remplacer…') {
  await user.click(within(card).getByRole('button', { name }));
  return screen.findByRole('dialog');
}

describe('AnthropicKey', () => {
  it('shows its state first, the last 4 characters and the expiry, never a full key', () => {
    const { card } = open();
    expect(within(card).getByText('En service')).toBeInTheDocument();
    expect(within(card).getByText('7f3a')).toBeInTheDocument();
    expect(within(card).getByText('31 déc. 2026')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/sk-ant/);
  });

  it('shows each state with its label', () => {
    const labels = { refused: 'Refusée', credit: 'Crédit épuisé', absent: 'Absente' } as const;
    for (const [state, label] of Object.entries(labels)) {
      const { client } = fakeClient();
      const status = (
        state === 'absent' ? { state } : { state, last4: '7f3a', source: 'saved' }
      ) as AnthropicKeyStatus;
      const { unmount } = render(AnthropicKey, { props: { client, status } });
      expect(screen.getByText(label)).toBeInTheDocument();
      if (state === 'absent') {
        expect(screen.queryByText(/Se termine par/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Ajouter une clé' })).toBeInTheDocument();
      }
      unmount();
    }
  });

  it('replaces the key in a window and shows the new state', async () => {
    const { client, user, card } = open();
    client.saveAnthropicKey.mockResolvedValueOnce({
      state: 'ok',
      last4: 'c0de',
      expires: '2027-03-01',
      source: 'saved',
    });
    const window = await replace(user, card);
    const field = within(window).getByLabelText('Nouvelle clé');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    await user.type(field, NEW_KEY);
    await user.type(within(window).getByLabelText('Échéance (facultatif)'), '2027-03-01');
    await user.click(within(window).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(client.saveAnthropicKey).toHaveBeenCalledWith(NEW_KEY, '2027-03-01');
    expect(await within(card).findByText('c0de')).toBeInTheDocument();
    expect(within(card).getByText('1 mars 2027')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('saves without an expiry', async () => {
    const { client, user, card } = open();
    client.saveAnthropicKey.mockResolvedValueOnce({ state: 'ok', last4: 'c0de', source: 'saved' });
    const window = await replace(user, card);
    await user.type(within(window).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(within(window).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(client.saveAnthropicKey).toHaveBeenCalledWith(NEW_KEY, undefined);
    expect(await within(card).findByText('c0de')).toBeInTheDocument();
    expect(within(card).getByText('Aucune')).toBeInTheDocument();
  });

  it('a refused key keeps the window open with the reason, and the old state', async () => {
    const { client, user, card } = open();
    client.saveAnthropicKey.mockRejectedValueOnce(
      new ApiError(400, 'Clé refusée par Anthropic, rien n’a changé'),
    );
    const window = await replace(user, card);
    await user.type(within(window).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(within(window).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(await within(window).findByText('Clé refusée par Anthropic, rien n’a changé')).toBeInTheDocument();
    expect(within(card).getByText('En service')).toBeInTheDocument();
    expect(within(card).getByText('7f3a')).toBeInTheDocument();
  });

  it('shows the check in progress on the button', async () => {
    const { client, user, card } = open();
    let answer!: (v: AnthropicKeyStatus) => void;
    client.saveAnthropicKey.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const window = await replace(user, card);
    const button = within(window).getByRole('button', { name: 'Vérifier et enregistrer' });
    expect(button).toBeDisabled();
    await user.type(within(window).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(button);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(within(window).getByText('Vérification auprès d’Anthropic…')).toBeInTheDocument();
    answer({ state: 'ok', last4: 'c0de' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('the window stays open while the key is being checked', async () => {
    const { client, user, card } = open();
    client.saveAnthropicKey.mockReturnValueOnce(new Promise(() => {}));
    const window = await replace(user, card);
    await user.type(within(window).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(within(window).getByRole('button', { name: 'Vérifier et enregistrer' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('removing the key goes through a confirmation', async () => {
    const { client, user, card } = open();
    await user.click(within(card).getByRole('button', { name: 'Retirer' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveAccessibleName('Retirer la clé Anthropic ?');
    expect(client.deleteAnthropicKey).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Retirer la clé' }));
    expect(client.deleteAnthropicKey).toHaveBeenCalled();
    expect(await within(card).findByText('Absente')).toBeInTheDocument();
  });

  it('a key from the .env file cannot be removed here', () => {
    const { card } = open({ state: 'ok', last4: '9876', source: 'env' });
    expect(within(card).queryByRole('button', { name: 'Retirer' })).not.toBeInTheDocument();
    expect(within(card).getByText('Clé du fichier .env')).toBeInTheDocument();
  });
});
