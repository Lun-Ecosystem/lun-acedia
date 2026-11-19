import { render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../client.ts';
import { fakeClient } from '../../testing/fake-client.ts';
import Toaster from '../ui/Toaster.svelte';
import { dismissAll } from '../ui/toasts.svelte.ts';
import { takeIdentity } from './identity.svelte.ts';
import { PinaState } from './pina.svelte.ts';

afterEach(() => {
  dismissAll();
  takeIdentity({ name: 'Agent' });
  document.body.innerHTML = '';
});

describe('the message of a request that fails without a reason', () => {
  async function failing() {
    const { client } = fakeClient();
    client.pinaAsk.mockRejectedValue('boom');
    await new PinaState(client).ask('Salut', { screen: 'mail' });
  }

  it('names the agent « Agent » on a fresh install, then the name of its settings', async () => {
    render(Toaster);
    await failing();
    expect(await screen.findByText('Agent ne répond pas')).toBeInTheDocument();
    dismissAll();
    takeIdentity({ name: 'Iris' });
    await failing();
    expect(await screen.findByText('Iris ne répond pas')).toBeInTheDocument();
  });

  it('is never written « Pina »', async () => {
    render(Toaster);
    await failing();
    expect(screen.queryByText(/Pina/)).toBeNull();
  });
});

describe('reading the thread', () => {
  it('says why it failed when asked, and nothing when quiet', async () => {
    render(Toaster);
    const { client } = fakeClient();
    client.pinaToday.mockRejectedValue(new Error('Hors ligne'));
    await new PinaState(client).load(true);
    expect(screen.queryByText('Hors ligne')).toBeNull();
    await new PinaState(client).load();
    expect(await screen.findByText('Hors ligne')).toBeInTheDocument();
  });
});

describe('a card the server withdrew', () => {
  it('Annuler on it reads the thread again and says the card is gone', async () => {
    render(Toaster);
    const { client } = fakeClient();
    client.pinaUndo.mockRejectedValue(new ApiError(404, 'Carte inconnue'));
    await new PinaState(client).undo(10);
    expect(await screen.findByText('Cette carte n’existe plus')).toBeInTheDocument();
    expect(client.pinaToday).toHaveBeenCalledTimes(1);
  });
});

describe('the fake client', () => {
  it('carries a name of settings that is not « Pina »', async () => {
    const { client } = fakeClient();
    expect((await client.getPinaSettings()).name).toBe('Iris');
    expect((await client.updatePinaSettings({})).name).toBe('Iris');
  });
});
