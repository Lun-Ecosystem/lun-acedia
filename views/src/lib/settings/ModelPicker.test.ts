import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MODELS } from '../../testing/fake-client.ts';
import ModelPicker from './ModelPicker.svelte';

import { stubSelect } from '../../testing/select.ts';

stubSelect();

describe('ModelPicker', () => {
  it('ModelPicker shows the tier and "prix inconnu" without price', async () => {
    const onchange = vi.fn();
    const user = userEvent.setup();
    const value = { provider: 'anthropic' as const, model: 'claude-haiku-5-5' };
    render(ModelPicker, { props: { use: 'triage', models: MODELS, value, onchange } });
    const trigger = screen.getByRole('combobox', { name: 'Modèle du tri' });
    expect(trigger).toHaveTextContent('Claude Haiku 5.5');
    // The chosen model, said under the picker.
    expect(screen.getByText('Anthropic · 0,10 / 0,50 $ par M jetons')).toBeInTheDocument();
    expect(screen.getByText('€')).toBeInTheDocument();

    await user.click(trigger);
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options.map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Claude Haiku 5.5 Anthropic · 0,10 / 0,50 $ par M jetons · €',
      'GPT-6 Astra OpenAI · 10 / 50 $ par M jetons · €€€',
      'GPT maison OpenAI · prix inconnu',
    ]);
    expect(screen.queryByText(/\b0 \$/)).not.toBeInTheDocument();
    await user.click(within(options[2]!).getByText('GPT maison'));
    expect(onchange).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-maison' });
  });

  it('invites to choose when nothing is chosen yet', () => {
    render(ModelPicker, { props: { use: 'triage', models: MODELS, value: null, onchange: vi.fn() } });
    expect(screen.getByRole('combobox', { name: 'Modèle du tri' })).toHaveTextContent('Choisir un modèle…');
  });
});
