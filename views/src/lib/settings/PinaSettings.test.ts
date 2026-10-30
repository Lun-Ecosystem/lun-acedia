import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import { agentIdentity } from '../pina/identity.svelte.ts';
import { dismissAll } from '../ui/toasts.svelte.ts';
import PinaSettings from './PinaSettings.svelte';

async function setup() {
  const fake = fakeClient();
  fake.client.getPinaSettings.mockResolvedValue({
    mode: 'validate',
    instructions: 'Signer Natsume.',
    retentionDays: 30,
    dailyCapUsd: 1,
    name: 'Pina',
    icon: 'sparkles',
    tone: 'chaleureux',
    persona: '',
    spentTodayUsd: 0.25,
  });
  const user = userEvent.setup();
  render(PinaSettings, { props: { client: fake.client } });
  await screen.findByRole('radiogroup', { name: 'Mode de l’agent' });
  return { ...fake, user };
}

describe('PinaSettings', () => {
  afterEach(() => dismissAll());

  it('Pina settings save and bound values', async () => {
    const { client, user } = await setup();
    const put = client.updatePinaSettings;
    expect(screen.getByText('Les suppressions demandent toujours une validation.')).toBeInTheDocument();
    expect(screen.getByText(/0,25 \$ sur 1 \$/)).toBeInTheDocument();

    // Mode: one click on the other option saves it.
    await user.click(screen.getByRole('radio', { name: /Faire tout de suite/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ mode: 'immediate' }));

    // Retention: out of 1..365 says so and saves nothing; a good value saves on leaving the field.
    const days = screen.getByRole('spinbutton', { name: 'Conservation du fil' });
    await user.clear(days);
    await user.type(days, '400');
    await user.tab();
    expect(await screen.findByText('Entre 1 et 365 jours.')).toBeInTheDocument();
    expect(put).not.toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 400 }));
    await user.clear(days);
    await user.type(days, '14');
    await user.tab();
    await waitFor(() => expect(put).toHaveBeenCalledWith({ retentionDays: 14 }));
    expect(screen.queryByText('Entre 1 et 365 jours.')).not.toBeInTheDocument();

    // Daily cap: 0..50 $.
    const cap = screen.getByRole('spinbutton', { name: 'Plafond quotidien' });
    await user.clear(cap);
    await user.type(cap, '60');
    await user.tab();
    expect(await screen.findByText('Entre 0 et 50 $.')).toBeInTheDocument();
    expect(put).not.toHaveBeenCalledWith(expect.objectContaining({ dailyCapUsd: 60 }));
    await user.clear(cap);
    await user.type(cap, '2.5');
    await user.tab();
    await waitFor(() => expect(put).toHaveBeenCalledWith({ dailyCapUsd: 2.5 }));

    // Instructions: 2000 characters at most, saved by their button.
    const text = screen.getByRole('textbox', { name: 'Consignes' });
    await user.clear(text);
    await user.click(text);
    await user.paste('x'.repeat(2100));
    expect(text).toHaveValue('x'.repeat(2000));
    expect(screen.getByText('2000 / 2000')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer les consignes' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ instructions: 'x'.repeat(2000) }));
  });

  it('a model without a known price says the daily cap cannot count it', async () => {
    const fake = fakeClient();
    fake.client.getModelChoice.mockResolvedValue({
      triage: null,
      pina: { provider: 'openai', model: 'gpt-maison' },
    });
    render(PinaSettings, { props: { client: fake.client } });
    expect(
      await screen.findByText('Prix inconnu : le plafond quotidien ne compte pas ce que ce modèle coûte.'),
    ).toBeInTheDocument();
  });

  it('the model of Pina is chosen among the tool models', async () => {
    const { client } = await setup();
    await waitFor(() => expect(client.getModels).toHaveBeenCalledWith('pina'));
    expect(await screen.findByRole('combobox', { name: 'Modèle de l’agent' })).toBeInTheDocument();
  });

  it('the identity is a setting: the name trimmed, never empty, and it follows everywhere', async () => {
    const { client, user } = await setup();
    const put = client.updatePinaSettings;
    const name = screen.getByRole('textbox', { name: 'Nom' });
    await user.clear(name);
    await user.tab();
    expect(await screen.findByText('Un nom, de 1 à 40 caractères.')).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
    await user.type(name, '  Lune  ');
    await user.tab();
    await waitFor(() => expect(put).toHaveBeenCalledWith({ name: 'Lune' }));
    expect(agentIdentity.name).toBe('Lune');

    await user.click(screen.getByRole('radio', { name: 'Concis' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ tone: 'concis' }));

    const persona = screen.getByRole('textbox', { name: 'Contexte du personnage' });
    await user.click(persona);
    await user.paste('Une viera de bonne humeur.');
    await user.tab();
    await waitFor(() => expect(put).toHaveBeenCalledWith({ persona: 'Une viera de bonne humeur.' }));
  });
});
