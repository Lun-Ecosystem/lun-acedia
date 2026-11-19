import { render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('the fake client', () => {
  it('carries a name of settings that is not « Pina »', async () => {
    const { client } = fakeClient();
    expect((await client.getPinaSettings()).name).toBe('Iris');
    expect((await client.updatePinaSettings({})).name).toBe('Iris');
  });
});
