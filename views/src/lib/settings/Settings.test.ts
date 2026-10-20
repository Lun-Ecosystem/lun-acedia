import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import Settings from './Settings.svelte';

async function open() {
  const { client } = fakeClient();
  const user = userEvent.setup();
  render(Settings, { props: { client } });
  await screen.findByRole('heading', { name: 'Réglages' });
  return { client, user };
}

describe('Settings', () => {
  it('saves the confidence threshold', async () => {
    const { client, user } = await open();
    const section = screen.getByRole('region', { name: 'Seuil de confiance' });
    const input = within(section).getByLabelText('Seuil (%)');
    await waitFor(() => expect(input).toHaveValue(100));
    await user.clear(input);
    await user.type(input, '80');
    await user.click(within(section).getByRole('button', { name: 'Enregistrer' }));
    expect(client.putSettings).toHaveBeenCalledWith({ threshold: 80 });
  });

  it('creates a box', async () => {
    const { client, user } = await open();
    client.createLabel.mockResolvedValueOnce({ id: 'L-new', name: 'Banque', type: 'user', role: 'box' });
    const section = screen.getByRole('region', { name: 'Boîtes et étiquettes' });
    await user.type(within(section).getByLabelText('Nouvelle boîte'), 'Banque');
    await user.click(within(section).getByRole('button', { name: 'Créer la boîte' }));
    expect(client.createLabel).toHaveBeenCalledWith('Banque', 'box');
    expect(await within(section).findByText('Banque')).toBeInTheDocument();
  });

  it('shows a 6-digit pairing code and its expiry', async () => {
    const { client, user } = await open();
    client.createPairingCode.mockResolvedValueOnce({ code: '042517', expiresAt: '2026-11-02T08:10:00.000Z' });
    const section = screen.getByRole('region', { name: 'Appairage' });
    await user.click(within(section).getByRole('button', { name: 'Générer un code' }));
    expect(await within(section).findByText('042517')).toBeInTheDocument();
    expect(within(section).getByText(/Expire à/)).toBeInTheDocument();
  });

  it('adds a rule', async () => {
    const { client, user } = await open();
    client.saveRule.mockImplementationOnce(
      async (r) =>
        ({
          id: 1,
          tagIds: [],
          enabled: true,
          position: 1,
          ...r,
        }) as never,
    );
    const section = screen.getByRole('region', { name: 'Règles' });
    await user.type(within(section).getByLabelText('Valeur'), 'ecole.fr');
    await user.selectOptions(within(section).getByLabelText('Champ'), 'fromDomain');
    await user.selectOptions(within(section).getByLabelText('Boîte'), 'L-ecole');
    await user.click(within(section).getByRole('button', { name: 'Ajouter la règle' }));
    expect(client.saveRule).toHaveBeenCalledWith({
      field: 'fromDomain',
      op: 'equals',
      value: 'ecole.fr',
      boxId: 'L-ecole',
    });
  });

  it('shows the connected Google account', async () => {
    await open();
    const section = screen.getByRole('region', { name: 'Compte Google' });
    expect(await within(section).findByText(/moi@example\.com/)).toBeInTheDocument();
  });
});
