import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../client.ts';
import { fakeClient } from '../../testing/fake-client.ts';
import AnthropicKey from './AnthropicKey.svelte';

const NEW_KEY = 'sk-ant-test-000000000000c0de';

async function open() {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(AnthropicKey, { props: { client } });
  const section = screen.getByRole('region', { name: 'Clé Anthropic' });
  await within(section).findByText('En service');
  return { client, user, section };
}

describe('AnthropicKey', () => {
  it('shows state, last 4 and expiry, never a full key', async () => {
    const { section } = await open();
    expect(within(section).getByRole('heading', { name: 'Clé Anthropic' })).toBeInTheDocument();
    expect(within(section).getByText('Se termine par 7f3a')).toBeInTheDocument();
    expect(within(section).getByText('Échéance déclarée : 31/12/2026')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/sk-ant/);
  });

  it('shows each state with its label', async () => {
    const labels = {
      refused: 'Refusée',
      credit: 'Crédit épuisé',
      absent: 'Absente : seules les règles trient',
    } as const;
    for (const [state, label] of Object.entries(labels)) {
      const { client } = fakeClient();
      client.getAnthropicKey.mockResolvedValueOnce(
        state === 'absent' ? { state: 'absent' } : { state: state as 'refused' | 'credit', last4: '7f3a' },
      );
      const { unmount } = render(AnthropicKey, { props: { client } });
      expect(await screen.findByText(label)).toBeInTheDocument();
      if (state === 'absent') expect(screen.queryByText(/Se termine par/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('saves a key and shows the new state', async () => {
    const { client, user, section } = await open();
    client.saveAnthropicKey.mockResolvedValueOnce({
      state: 'ok',
      last4: 'c0de',
      expires: '2027-03-01',
      source: 'saved',
    });
    await user.type(within(section).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.type(within(section).getByLabelText('Échéance (facultatif)'), '2027-03-01');
    await user.click(within(section).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(client.saveAnthropicKey).toHaveBeenCalledWith(NEW_KEY, '2027-03-01');
    expect(await within(section).findByText('Se termine par c0de')).toBeInTheDocument();
    expect(within(section).getByText('Échéance déclarée : 01/03/2027')).toBeInTheDocument();
    expect(within(section).getByRole('status')).toHaveTextContent('Clé vérifiée et enregistrée.');
  });

  it('saves without an expiry', async () => {
    const { client, user, section } = await open();
    client.saveAnthropicKey.mockResolvedValueOnce({ state: 'ok', last4: 'c0de', source: 'saved' });
    await user.type(within(section).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(within(section).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(client.saveAnthropicKey).toHaveBeenCalledWith(NEW_KEY, undefined);
    expect(await within(section).findByText('Se termine par c0de')).toBeInTheDocument();
    expect(within(section).queryByText(/Échéance déclarée/)).not.toBeInTheDocument();
  });

  it('shows the refusal message and keeps the old state', async () => {
    const { client, user, section } = await open();
    client.saveAnthropicKey.mockRejectedValueOnce(
      new ApiError(400, 'Clé refusée par Anthropic, rien n’a changé'),
    );
    await user.type(within(section).getByLabelText('Nouvelle clé'), NEW_KEY);
    await user.click(within(section).getByRole('button', { name: 'Vérifier et enregistrer' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Clé refusée par Anthropic, rien n’a changé',
    );
    expect(within(section).getByText('En service')).toBeInTheDocument();
    expect(within(section).getByText('Se termine par 7f3a')).toBeInTheDocument();
    expect(within(section).queryByRole('status')).not.toBeInTheDocument();
  });

  it('the key field is cleared after saving and is of type password', async () => {
    const { client, user, section } = await open();
    const field = within(section).getByLabelText('Nouvelle clé');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    client.saveAnthropicKey.mockResolvedValueOnce({ state: 'ok', last4: 'c0de', source: 'saved' });
    await user.type(field, NEW_KEY);
    await user.click(within(section).getByRole('button', { name: 'Vérifier et enregistrer' }));
    await within(section).findByText('Se termine par c0de');
    expect(field).toHaveValue('');
  });

  it('disables the button while the key is being checked', async () => {
    const { client, user, section } = await open();
    let answer!: (v: { state: 'ok'; last4: string }) => void;
    client.saveAnthropicKey.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const button = within(section).getByRole('button', { name: 'Vérifier et enregistrer' });
    expect(button).toBeDisabled();
    await user.type(within(section).getByLabelText('Nouvelle clé'), NEW_KEY);
    expect(button).toBeEnabled();
    await user.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(within(section).getByText('Vérification auprès d’Anthropic…')).toBeInTheDocument();
    answer({ state: 'ok', last4: 'c0de' });
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy', 'true'));
  });
});
