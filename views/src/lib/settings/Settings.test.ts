import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import type { Rule } from '../types.ts';
import { stubSelect } from '../../testing/select.ts';
import Settings from './Settings.svelte';

stubSelect();

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
    ).toEqual([
      'Compte Google',
      'Appareils et applications',
      'Tri par l’IA',
      'Boîtes et règles',
      'Fournisseurs d’IA',
    ]);
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

  it('a reorder that fails half-way shows the order the server kept', async () => {
    // The first save went through, the second did not: both rules now share position 1.
    const kept = [
      { ...RULES[0]!, position: 1 },
      { ...RULES[1]!, position: 1 },
    ];
    const { client, user, go } = await open((c) => {
      c.listRules.mockResolvedValueOnce(structuredClone(RULES)).mockResolvedValueOnce(kept);
      c.saveRule
        .mockImplementationOnce(async (r) => ({ ...RULES.find((x) => x.id === r.id)!, ...r }) as Rule)
        .mockRejectedValueOnce(new Error('Anthropic injoignable'));
    });
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Règles' });
    const second = (await within(card).findAllByRole('listitem'))[1]!;
    await user.click(within(second).getByRole('button', { name: 'Actions de la règle 2' }));
    await user.click(await menuEntry('Monter'));
    expect(await within(card).findByRole('alert')).toHaveTextContent('Anthropic injoignable');
    expect(client.listRules).toHaveBeenCalledTimes(2);
    expect(within(card).getAllByRole('listitem')[0]!.textContent).toContain('factures@example.com');
  });

  it('reorders by dragging a rule by its handle', async () => {
    const { client, go } = await open((c) => {
      c.listRules.mockResolvedValue(structuredClone(RULES));
      c.saveRule.mockImplementation(async (r) => ({ ...RULES.find((x) => x.id === r.id)!, ...r }) as Rule);
    });
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Règles' });
    const [first, second] = await within(card).findAllByRole('listitem');
    // Only the handle arms the row.
    expect(second).toHaveAttribute('draggable', 'false');
    await fireEvent.pointerDown(second!.querySelector('.poignee')!);
    expect(second).toHaveAttribute('draggable', 'true');
    const dataTransfer = { setData: () => {}, effectAllowed: '' };
    await fireEvent.dragStart(second!, { dataTransfer });
    await fireEvent.dragOver(first!, { dataTransfer });
    await fireEvent.drop(first!, { dataTransfer });
    expect(client.saveRule).toHaveBeenCalledWith(expect.objectContaining({ id: 9, position: 1 }));
    expect(client.saveRule).toHaveBeenCalledWith(expect.objectContaining({ id: 7, position: 2 }));
  });

  it('after deleting a rule, the focus goes to the row now in its place', async () => {
    const { client, user, go } = await open((c) => {
      c.listRules.mockResolvedValue(structuredClone(RULES));
      c.deleteRule.mockResolvedValue();
    });
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Règles' });
    await user.click(await within(card).findByRole('button', { name: 'Supprimer la règle 1' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Supprimer la règle' }));
    expect(client.deleteRule).toHaveBeenCalledWith(7);
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'Actions de la règle 1' })).toHaveFocus(),
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
    // The removed row's button is gone: the focus goes to the row now in its place.
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Retirer' })).toHaveFocus());
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

  it('links a device: a window shows the code grouped by three, its expiry, and copies it', async () => {
    const { client, user, go } = await open();
    const expiresAt = new Date(Date.now() + 6 * 60_000).toISOString();
    client.createPairingCode.mockResolvedValueOnce({ code: '042517', expiresAt });
    await go('Appareils et applications');
    const trigger = screen.getByRole('button', { name: 'Relier un appareil' });
    await user.click(trigger);
    const window = await screen.findByRole('dialog', { name: 'Code pour un nouvel appareil' });
    const time = new Date(expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    expect(window).toHaveAccessibleDescription(
      `Saisir ce code sur l’appareil à relier. Il expire à ${time}.`,
    );
    expect(within(window).getByText('042')).toBeInTheDocument();
    expect(within(window).getByText('517')).toBeInTheDocument();
    expect(within(window).getByText(/^\d+ min restantes?$/)).toBeInTheDocument();
    expect(within(window).getByText('Usage unique')).toBeInTheDocument();

    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(within(window).getByRole('button', { name: 'Copier' }));
    expect(writeText).toHaveBeenCalledWith('042517');

    await user.click(within(window).getAllByRole('button', { name: 'Fermer' }).at(-1)!);
    // While it fades out, the window still says the code is live, not expired.
    expect(screen.queryByText('Ce code a expiré. En demander un nouveau.')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
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
      c.getProviders.mockResolvedValue([
        { id: 'anthropic', label: 'Anthropic', state: 'refused', last4: '7f3a', source: 'saved' },
      ]),
    );
    await go('Boîtes et règles');
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Clé Anthropic refusée : le tri par l’IA est en pause.');
    expect(banner).toHaveTextContent('Les règles continuent de s’appliquer.');
    await user.click(within(banner).getByRole('button', { name: 'Remplacer la clé' }));
    expect(await screen.findByRole('dialog', { name: 'Remplacer la clé' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fournisseurs d’IA', level: 2 })).toBeInTheDocument();
  });

  it('no banner while the key works', async () => {
    const { go } = await open();
    await screen.findByRole('combobox', { name: 'Modèle du tri' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await go('Boîtes et règles');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a phone for a device named after a phone, a screen otherwise', async () => {
    const { go } = await open((c) =>
      c.listClients.mockResolvedValue([
        {
          id: 1,
          name: 'Chrome sur Windows',
          kind: 'device',
          createdAt: '2026-10-19T08:00:00.000Z',
          current: true,
        },
        {
          id: 3,
          name: 'Safari sur iPhone',
          kind: 'device',
          createdAt: '2026-10-19T08:00:00.000Z',
          current: false,
        },
      ]),
    );
    await go('Appareils et applications');
    const icon = (name: string) => screen.getByText(name).closest('li')!.querySelector('.ico svg')!;
    expect(icon('Safari sur iPhone')).toHaveClass('lucide-smartphone');
    expect(icon('Chrome sur Windows')).toHaveClass('lucide-monitor');
  });

  it('keys that cannot be read still show a card, to retry', async () => {
    const { client, user, go } = await open((c) =>
      c.getProviders.mockRejectedValueOnce(new Error('Serveur injoignable')),
    );
    await go('Fournisseurs d’IA');
    const card = await screen.findByRole('region', { name: 'Fournisseurs d’IA' });
    expect(within(card).getByText('État des clés inconnu')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Réessayer' }));
    expect(client.getProviders).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('region', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('the triage model picker is in the triage page', async () => {
    const { client, user } = await open();
    const picker = await screen.findByRole('combobox', { name: 'Modèle du tri' });
    await waitFor(() => expect(picker).toHaveTextContent('Claude Haiku 5.5'));
    expect(client.getModels).toHaveBeenCalledWith('triage');
    await user.click(picker);
    const astra = (await screen.findAllByRole('option', { hidden: true })).find((o) =>
      o.textContent?.includes('GPT-6 Astra'),
    )!;
    await user.click(astra);
    expect(client.setModelChoice).toHaveBeenCalledWith('triage', 'openai', 'gpt-6-astra');
    await waitFor(() => expect(picker).toHaveTextContent('GPT-6 Astra'));
  });

  it('with models but none chosen (a custom endpoint alone), the triage page invites to choose', async () => {
    await open((c) => {
      c.getModels.mockResolvedValue([
        { provider: 'custom', id: 'llama4', label: 'llama4', tools: true, tier: null },
      ]);
      c.getModelChoice.mockResolvedValue({ triage: null, pina: null });
    });
    expect(
      await screen.findByText(
        'Aucun modèle choisi : seules les règles trient tant qu’un modèle n’est pas choisi.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Modèle du tri' })).toHaveTextContent('Choisir un modèle…');
  });

  it('without any provider, the triage page sends to the providers', async () => {
    const { user } = await open((c) => {
      c.getModels.mockResolvedValue([]);
      c.getModelChoice.mockResolvedValue({ triage: null, pina: null });
    });
    const card = await screen.findByRole('region', { name: 'Modèle du tri' });
    await user.click(await within(card).findByRole('button', { name: 'Ajouter une clé' }));
    expect(await screen.findByRole('heading', { name: 'Fournisseurs d’IA', level: 2 })).toBeInTheDocument();
  });

  it('the theme link says when the key is refused, not only by a dot', async () => {
    const { themes } = await open((c) =>
      c.getProviders.mockResolvedValue([
        { id: 'anthropic', label: 'Anthropic', state: 'refused', last4: '7f3a', source: 'saved' },
      ]),
    );
    const link = within(themes).getByRole('link', { name: 'Fournisseurs d’IA' });
    await waitFor(() => expect(link).toHaveAccessibleDescription('Clé refusée'));
  });

  it('opening a theme moves the focus to its title, coming back to its link', async () => {
    const { user, themes } = await open();
    await user.click(within(themes).getByRole('link', { name: 'Compte Google' }));
    const title = screen.getByRole('heading', { name: 'Compte Google', level: 2 });
    await waitFor(() => expect(title).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Réglages' }));
    await waitFor(() => expect(within(themes).getByRole('link', { name: 'Compte Google' })).toHaveFocus());
  });

  it('cancelling a new box forgets what was typed', async () => {
    const { user, go } = await open();
    await go('Boîtes et règles');
    const card = screen.getByRole('region', { name: 'Boîtes et étiquettes' });
    await user.click(within(card).getByRole('button', { name: 'Nouvelle' }));
    await user.type(within(await screen.findByRole('dialog')).getByLabelText('Nom'), 'Banque');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(within(card).getByRole('button', { name: 'Nouvelle' }));
    expect(within(await screen.findByRole('dialog')).getByLabelText('Nom')).toHaveValue('');
  });

  it('a late answer for a label role never replaces a newer choice', async () => {
    let first!: (v: { id: string; name: string; type: string; role: 'box' }) => void;
    const { client, user, go } = await open((c) => {
      c.updateLabel
        .mockReturnValueOnce(new Promise((r) => (first = r)))
        .mockResolvedValueOnce({ id: 'L-urgent', name: 'Urgent', type: 'user' });
    });
    await go('Boîtes et règles');
    const urgent = screen.getByRole('group', { name: 'Rôle de Urgent' });
    await user.click(within(urgent).getByRole('radio', { name: 'Boîte' }));
    await user.click(within(urgent).getByRole('radio', { name: 'Ignorée' }));
    expect(client.updateLabel).toHaveBeenCalledTimes(2);
    first({ id: 'L-urgent', name: 'Urgent', type: 'user', role: 'box' });
    await new Promise((r) => setTimeout(r, 0));
    expect(within(urgent).getByRole('radio', { name: 'Ignorée' })).toHaveAttribute('aria-checked', 'true');
  });
});
