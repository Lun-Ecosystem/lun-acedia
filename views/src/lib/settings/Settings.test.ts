import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

  it('Devices lists devices and apps and revokes one', async () => {
    const { client, user } = await open();
    const section = screen.getByRole('region', { name: 'Appareils et applications' });
    expect(within(section).getByText("Ce qui a accès à Lun'Acedia.")).toBeInTheDocument();
    const self = (await within(section).findByText('Ce navigateur')).closest('li')!;
    expect(within(self).getByText(/appareil · relié le 19\/10\/2026/)).toBeInTheDocument();
    const app = within(section).getByText('Assistant local').closest('li')!;
    expect(within(app).getByText(/application · reliée le 20\/10\/2026/)).toBeInTheDocument();

    await user.click(within(app).getByRole('button', { name: 'Retirer' }));
    expect(client.revokeClient).toHaveBeenCalledWith(2);
    expect(await within(section).findByRole('status')).toHaveTextContent('Accès retiré : Assistant local.');
    expect(within(section).queryByText('Assistant local')).not.toBeInTheDocument();
    expect(within(section).getByText('Ce navigateur')).toBeInTheDocument();
  });

  it('asks before revoking this browser, then hands over once', async () => {
    const { client } = fakeClient();
    const onSelfRevoked = vi.fn();
    const user = userEvent.setup();
    render(Settings, { props: { client, onSelfRevoked } });
    const section = screen.getByRole('region', { name: 'Appareils et applications' });
    const self = (await within(section).findByText('Ce navigateur')).closest('li')!;

    await user.click(within(self).getByRole('button', { name: 'Retirer' }));
    expect(client.revokeClient).not.toHaveBeenCalled();
    await user.click(within(section).getByRole('button', { name: 'Annuler' }));
    expect(within(section).queryByRole('button', { name: 'Retirer ce navigateur' })).not.toBeInTheDocument();

    await user.click(within(self).getByRole('button', { name: 'Retirer' }));
    await user.click(within(section).getByRole('button', { name: 'Retirer ce navigateur' }));
    expect(client.revokeClient).toHaveBeenCalledWith(1);
    expect(onSelfRevoked).toHaveBeenCalledTimes(1);
    expect(client.listClients).toHaveBeenCalledTimes(1);
  });

  it('links a device with a 6-digit code and its expiry', async () => {
    const { client, user } = await open();
    client.createPairingCode.mockResolvedValueOnce({ code: '042517', expiresAt: '2026-11-02T08:10:00.000Z' });
    const section = screen.getByRole('region', { name: 'Appareils et applications' });
    await user.click(within(section).getByRole('button', { name: 'Relier un appareil' }));
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
