import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import type { Rule } from '../types.ts';
import Settings from './Settings.svelte';

const RULES: Rule[] = [
  {
    id: 7,
    field: 'from',
    op: 'equals',
    value: 'factures@example.com',
    boxId: 'L-ecole',
    tagIds: [],
    enabled: true,
    position: 1,
  },
  {
    id: 9,
    field: 'subject',
    op: 'contains',
    value: 'avis d’imposition',
    boxId: 'L-perso',
    tagIds: [],
    enabled: true,
    position: 2,
  },
];

const menuEntry = async (text: string) =>
  waitFor(() => {
    const entry = screen
      .queryAllByRole('menuitem', { hidden: true })
      .find((item) => item.textContent?.trim().startsWith(text));
    if (!entry) throw new Error(`No menu entry ${text}`);
    return entry;
  });

async function open(
  setup?: (client: ReturnType<typeof fakeClient>['client']) => void,
  onSelfRevoked = vi.fn(),
) {
  const { client } = fakeClient();
  setup?.(client);
  const user = userEvent.setup();
  render(Settings, { props: { client, onSelfRevoked } });
  await screen.findByRole('heading', { name: 'Réglages', level: 1 });
  const themes = screen.getByRole('navigation', { name: 'Thèmes des réglages' });
  const go = async (name: string) => {
    await user.click(within(themes).getByRole('link', { name }));
    return screen.findByRole('heading', { name, level: 2 });
  };
  return { client, user, themes, go, onSelfRevoked };
}

const dialog = () => screen.findByRole('alertdialog');

describe('Settings', () => {
  it('lists the themes in a column and opens the sorting page first', async () => {
    const { themes, go } = await open();
    expect(
      within(themes)
        .getAllByRole('link')
        .map((l) => l.textContent?.trim()),
    ).toEqual(['Compte Google', 'Appareils et applications', 'Tri par l’IA', 'Boîtes et règles']);
    expect(within(themes).getByRole('link', { name: 'Tri par l’IA' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Tri par l’IA', level: 2 })).toBeInTheDocument();
    await go('Boîtes et règles');
    expect(within(themes).getByRole('link', { name: 'Boîtes et règles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByRole('heading', { name: 'Tri par l’IA', level: 2 })).not.toBeInTheDocument();
  });

  it('saves the auto-filing threshold with its slider, and bounds the second one by the first', async () => {
    const { client, user } = await open((c) => {
      c.getSettings.mockResolvedValue({ threshold: 95, bulkThreshold: 85 });
      // The server lowers « Tout valider » with the auto-filing threshold.
      const saved = { threshold: 95, bulkThreshold: 85 };
      c.updateSettings.mockImplementation(async (patch) => {
        saved.threshold = patch.threshold ?? saved.threshold;
        saved.bulkThreshold = Math.min(patch.bulkThreshold ?? saved.bulkThreshold, saved.threshold);
        return { ...saved };
      });
    });
    const auto = await screen.findByRole('slider', { name: 'Ranger seul à partir de' });
    const bulk = screen.getByRole('slider', { name: '« Tout valider » à partir de' });
    await waitFor(() => expect(auto).toHaveAttribute('aria-valuenow', '95'));
    expect(bulk).toHaveAttribute('aria-valuenow', '85');
    expect(bulk).toHaveAttribute('aria-valuemax', '95');

    const autoValue = screen.getByRole('textbox', { name: 'Ranger seul à partir de' });
    await user.clear(autoValue);
    await user.type(autoValue, '80{Enter}');
    expect(client.updateSettings).toHaveBeenCalledWith({ threshold: 80 });
    await waitFor(() => expect(bulk).toHaveAttribute('aria-valuenow', '80'));
    expect(bulk).toHaveAttribute('aria-valuemax', '80');

    // Typed above the first threshold, the second one stops at it.
    const bulkValue = screen.getByRole('textbox', { name: '« Tout valider » à partir de' });
    await user.clear(bulkValue);
    await user.type(bulkValue, '75{Enter}');
    expect(client.updateSettings).toHaveBeenLastCalledWith({ bulkThreshold: 75 });
    await user.clear(bulkValue);
    await user.type(bulkValue, '99{Enter}');
    expect(client.updateSettings).toHaveBeenLastCalledWith({ bulkThreshold: 80 });
  });

  it('explains the two thresholds on a scale', async () => {
    await open((c) => c.getSettings.mockResolvedValue({ threshold: 95, bulkThreshold: 85 }));
    const scale = await screen.findByRole('img', { name: /En dessous de 85 %/ });
    expect(scale).toHaveAccessibleName(
      'En dessous de 85 % : un par un ; de 85 à 95 % : « Tout valider » ; à partir de 95 % : rangé seul',
    );
  });

  it('pauses and resumes the sorting from its card', async () => {
    const onchange = vi.fn();
    const { client } = fakeClient();
    const user = userEvent.setup();
    render(Settings, { props: { client, onchange } });
    const card = await screen.findByRole('region', { name: 'Tri en cours' });
    await user.click(within(card).getByRole('button', { name: 'Mettre en pause' }));
    expect(client.pause).toHaveBeenCalled();
    expect(await screen.findByRole('region', { name: 'Tri en pause' })).toBeInTheDocument();
    expect(onchange).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reprendre le tri' }));
    expect(client.resume).toHaveBeenCalled();
  });

  it('chooses the role of a label: Boîte, Étiquette or Ignorée (no role)', async () => {
    const { client, user, go } = await open((c) => {
      c.updateLabel.mockImplementation(async (id, { role }) => ({
        id,
        name: 'Urgent',
        type: 'user',
        ...(role ? { role } : {}),
      }));
    });
    await go('Boîtes et règles');
    const urgent = screen.getByRole('group', { name: 'Rôle de Urgent' });
    expect(within(urgent).getByRole('radio', { name: 'Étiquette' })).toHaveAttribute('aria-checked', 'true');
    expect(
      within(urgent)
        .getAllByRole('radio')
        .map((r) => r.textContent?.trim()),
    ).toEqual(['Boîte', 'Étiquette', 'Ignorée']);
    await user.click(within(urgent).getByRole('radio', { name: 'Ignorée' }));
    expect(client.updateLabel).toHaveBeenCalledWith('L-urgent', { role: null });
    expect(within(urgent).getByRole('radio', { name: 'Ignorée' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a label without a role shows as Ignorée; a refused change goes back', async () => {
    const { client, user, go } = await open((c) => {
      c.listLabels.mockResolvedValue([{ id: 'L-old', name: 'Ancien', type: 'user' }]);
      c.updateLabel.mockRejectedValue(new Error('Libellé inconnu'));
    });
    await go('Boîtes et règles');
    const old = screen.getByRole('group', { name: 'Rôle de Ancien' });
    expect(within(old).getByRole('radio', { name: 'Ignorée' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(old).getByRole('radio', { name: 'Boîte' }));
    expect(client.updateLabel).toHaveBeenCalledWith('L-old', { role: 'box' });
    expect(await screen.findByText('Libellé inconnu')).toBeInTheDocument();
    expect(within(old).getByRole('radio', { name: 'Ignorée' })).toHaveAttribute('aria-checked', 'true');
  });

  it('creates a box', async () => {
    const { client, user, go } = await open();
    client.createLabel.mockResolvedValueOnce({ id: 'L-new', name: 'Banque', type: 'user', role: 'box' });
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Boîtes et étiquettes' });
    await user.click(within(card).getByRole('button', { name: 'Nouvelle' }));
    const window = await screen.findByRole('dialog');
    await user.type(within(window).getByLabelText('Nom'), 'Banque');
    await user.click(within(window).getByRole('button', { name: 'Créer' }));
    expect(client.createLabel).toHaveBeenCalledWith('Banque', 'box');
    expect(await within(card).findByRole('group', { name: 'Rôle de Banque' })).toBeInTheDocument();
  });

  it('reads each rule as a sentence, in order', async () => {
    const { go } = await open((c) => c.listRules.mockResolvedValue(structuredClone(RULES)));
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Règles' });
    const rows = await within(card).findAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.phrase')?.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Si l’expéditeur est « factures@example.com », ranger dans École',
      'Si l’objet contient « avis d’imposition », ranger dans Perso',
    ]);
  });

  it('« Monter » on the second rule sends its new position', async () => {
    const { client, user, go } = await open((c) => {
      c.listRules.mockResolvedValue(structuredClone(RULES));
      c.saveRule.mockImplementation(async (r) => ({ ...RULES.find((x) => x.id === r.id)!, ...r }) as Rule);
    });
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Règles' });
    const second = (await within(card).findAllByRole('listitem'))[1]!;
    await user.click(within(second).getByRole('button', { name: 'Actions de la règle 2' }));
    await user.click(await menuEntry('Monter'));
    expect(client.saveRule).toHaveBeenCalledWith(expect.objectContaining({ id: 9, position: 1 }));
    expect(client.saveRule).toHaveBeenCalledWith(expect.objectContaining({ id: 7, position: 2 }));
    await waitFor(() =>
      expect(within(card).getAllByRole('listitem')[0]!.textContent).toContain('avis d’imposition'),
    );
  });

  it('adds a rule by completing the sentence', async () => {
    const { client, user, go } = await open();
    client.saveRule.mockImplementationOnce(
      async (r) => ({ id: 1, tagIds: [], enabled: true, position: 1, ...r }) as Rule,
    );
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Règles' });
    await user.type(within(card).getByLabelText('Valeur'), 'ecole.fr');
    await user.click(within(card).getByRole('button', { name: 'Ajouter' }));
    expect(client.saveRule).toHaveBeenCalledWith({
      field: 'from',
      op: 'contains',
      value: 'ecole.fr',
      boxId: 'L-ecole',
    });
    expect(await within(card).findByText('ecole.fr')).toBeInTheDocument();
  });

  it('lists devices and apps; removing one goes through a confirmation', async () => {
    const { client, user, go } = await open();
    await go('Appareils et applications');
    const card = screen.getByRole('region', { name: '2 accès' });
    const self = within(card).getByText("Lun'Acedia (app)").closest('li')!;
    expect(within(self).getByText('Ce navigateur')).toBeInTheDocument();
    expect(within(self).getByText(/Relié le 19 oct\./)).toBeInTheDocument();
    const app = within(card).getByText('Assistant local').closest('li')!;
    expect(within(app).getByText(/Application · reliée le 20 oct\./)).toBeInTheDocument();

    await user.click(within(app).getByRole('button', { name: 'Retirer' }));
    const confirm = await dialog();
    expect(confirm).toHaveAccessibleName('Retirer Assistant local ?');
    expect(client.revokeClient).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Retirer l’application' }));
    expect(client.revokeClient).toHaveBeenCalledWith(2);
    await waitFor(() => expect(within(card).queryByText('Assistant local')).not.toBeInTheDocument());
  });

  it('cancelling the confirmation keeps the device', async () => {
    const { client, user, go } = await open();
    await go('Appareils et applications');
    const app = screen.getByText('Assistant local').closest('li')!;
    await user.click(within(app).getByRole('button', { name: 'Retirer' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Annuler' }));
    expect(client.revokeClient).not.toHaveBeenCalled();
    expect(screen.getByText('Assistant local')).toBeInTheDocument();
  });

  it('removing this browser hands over once, after the confirmation', async () => {
    const { client, user, go, onSelfRevoked } = await open();
    await go('Appareils et applications');
    const self = screen.getByText("Lun'Acedia (app)").closest('li')!;
    await user.click(within(self).getByRole('button', { name: 'Retirer' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Retirer ce navigateur' }));
    expect(client.revokeClient).toHaveBeenCalledWith(1);
    expect(onSelfRevoked).toHaveBeenCalledTimes(1);
  });

  it('links a device with a 6-digit code and its expiry', async () => {
    const { client, user, go } = await open();
    client.createPairingCode.mockResolvedValueOnce({ code: '042517', expiresAt: '2026-11-02T08:10:00.000Z' });
    await go('Appareils et applications');
    await user.click(screen.getByRole('button', { name: 'Relier un appareil' }));
    expect(await screen.findByText('042517')).toBeInTheDocument();
    expect(screen.getByText(/Expire à/)).toBeInTheDocument();
  });

  it('shows the connected Google account and disconnects after a confirmation', async () => {
    const { client, user, go } = await open();
    client.googleDisconnect.mockResolvedValueOnce();
    await go('Compte Google');
    const card = screen.getByRole('region', { name: 'Compte Google' });
    expect(await within(card).findByText('moi@example.com')).toBeInTheDocument();
    expect(within(card).getByText('Connecté')).toBeInTheDocument();
    client.googleStatus.mockResolvedValueOnce({ connected: false });
    await user.click(within(card).getByRole('button', { name: 'Déconnecter' }));
    expect(client.googleDisconnect).not.toHaveBeenCalled();
    await user.click(within(await dialog()).getByRole('button', { name: 'Déconnecter le compte' }));
    expect(client.googleDisconnect).toHaveBeenCalled();
    expect(await within(card).findByText('Non connecté')).toBeInTheDocument();
  });

  it('a refused key shows a banner with « Remplacer la clé » on the sorting pages', async () => {
    const { user, go } = await open((c) =>
      c.getAnthropicKey.mockResolvedValue({ state: 'refused', last4: '7f3a', source: 'saved' }),
    );
    await go('Boîtes et règles');
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Clé Anthropic refusée : le tri par l’IA est en pause.');
    expect(banner).toHaveTextContent('Les règles continuent de s’appliquer.');
    await user.click(within(banner).getByRole('button', { name: 'Remplacer la clé' }));
    expect(await screen.findByRole('dialog', { name: 'Remplacer la clé' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tri par l’IA', level: 2 })).toBeInTheDocument();
  });

  it('no banner while the key works', async () => {
    const { go } = await open();
    await screen.findByText('Se termine par');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await go('Boîtes et règles');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
