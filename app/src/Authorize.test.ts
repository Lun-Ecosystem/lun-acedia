// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { AcediaClient } from '@lun-ecosystem/lunacedia-views';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Authorize from './Authorize.svelte';

const request = {
  client: 'Assistant local',
  redirect_uri: 'http://127.0.0.1:53682/callback',
  state: 'state-1',
  code_challenge: 'challenge-1',
};

function setup(over: Partial<typeof request> = {}) {
  const authorize = vi.fn<AcediaClient['authorize']>(async (req) => ({
    redirect: `${req.redirect_uri}?decision=${req.decision}`,
  }));
  const navigate = vi.fn<(url: string) => void>();
  const client = { authorize } as unknown as AcediaClient;
  render(Authorize, { props: { client, request: { ...request, ...over }, navigate } });
  return { authorize, navigate, user: userEvent.setup() };
}

describe('Authorize', () => {
  it('Authorize shows the client name and the return host:port, and follows the redirect', async () => {
    const { authorize, navigate, user } = setup();
    expect(
      screen.getByRole('heading', { level: 1, name: "Assistant local demande l'accès à Lun'Acedia" }),
    ).toBeInTheDocument();
    expect(screen.getByText('Retour vers 127.0.0.1:53682')).toBeInTheDocument();
    expect(screen.getByText('lire et ranger les mails')).toBeInTheDocument();
    expect(
      screen.getByText('Accès retirable à tout moment dans Réglages, Appareils et applications.'),
    ).toBeInTheDocument();
    expect(authorize).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Autoriser' }));
    expect(authorize).toHaveBeenCalledExactlyOnceWith({ ...request, decision: 'allow' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:53682/callback?decision=allow');
  });

  it('sends the refusal and follows its redirect', async () => {
    const { authorize, navigate, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Refuser' }));
    expect(authorize).toHaveBeenCalledExactlyOnceWith({ ...request, decision: 'deny' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:53682/callback?decision=deny');
  });

  it('shows the client name as text only', () => {
    setup({ client: '<img src=x onerror=alert(1)>' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      "<img src=x onerror=alert(1)> demande l'accès à Lun'Acedia",
    );
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the error and allows a new try when the server refuses', async () => {
    const { authorize, navigate, user } = setup();
    authorize.mockRejectedValueOnce(new Error('Seul un appareil relié peut autoriser une application'));
    await user.click(screen.getByRole('button', { name: 'Autoriser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Seul un appareil relié');
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Autoriser' })).toBeEnabled();
  });
});
