import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import type { DraftView } from '../types.ts';
import { dismissAll } from '../ui/toasts.svelte.ts';
import Composer from './Composer.svelte';

const DRAFT: DraftView = {
  id: 'd1',
  to: 'marie@example.com',
  subject: 'Re: Dîner samedi ?',
  text: 'Coucou Marie, ok pour 20 h.',
  replyTo: { id: '<m1@example.com>', threadId: 't1' },
};

function setup() {
  const fake = fakeClient();
  fake.client.getDraft.mockResolvedValue(DRAFT);
  fake.client.updateDraft.mockImplementation(async (id, d) => ({ ...DRAFT, id, text: d.text ?? '' }));
  fake.client.sendDraft.mockResolvedValue({ id: 'sent1', threadId: 't1' });
  fake.client.deleteDraft.mockResolvedValue({ ok: true });
  const onsent = vi.fn();
  const onclose = vi.fn();
  render(Composer, { props: { client: fake.client, draftId: 'd1', onsent, onclose } });
  return { ...fake, user: userEvent.setup(), onsent, onclose };
}

describe('Composer', () => {
  afterEach(() => dismissAll());

  it('composer opened from a draft shows the banner and sends through drafts/send', async () => {
    const { client, user, onsent } = setup();
    expect(await screen.findByText('Brouillon préparé par Pina.')).toBeInTheDocument();
    expect(
      screen.getByText(/Relire avant d’envoyer : rien ne part sans un clic sur Envoyer\./),
    ).toBeInTheDocument();
    const message = screen.getByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(message).toHaveValue(DRAFT.text));
    expect(screen.getByRole('textbox', { name: 'Objet' })).toHaveValue(DRAFT.subject);

    await user.type(message, ' À samedi.');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(onsent).toHaveBeenCalled());
    expect(client.getDraft).toHaveBeenCalledWith('d1');
    // What was changed here is saved into the draft, then that draft leaves; never a fresh mail.
    expect(client.updateDraft).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({
        to: DRAFT.to,
        text: `${DRAFT.text} À samedi.`,
        threadId: 't1',
        inReplyTo: '<m1@example.com>',
      }),
    );
    expect(client.sendDraft).toHaveBeenCalledWith('d1');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('a draft written from an alias is saved and sent from that alias', async () => {
    const fake = fakeClient();
    fake.client.sendAs.mockResolvedValue({
      addresses: [
        { email: 'moi@example.com', name: 'Moi', primary: true },
        { email: 'ecole@example.com', name: 'École', primary: false },
      ],
      default: 'moi@example.com',
    });
    fake.client.getDraft.mockResolvedValue({ ...DRAFT, from: 'ecole@example.com' });
    fake.client.updateDraft.mockImplementation(async (id) => ({ ...DRAFT, id }));
    fake.client.sendDraft.mockResolvedValue({ id: 'sent1', threadId: 't1' });
    const onsent = vi.fn();
    render(Composer, { props: { client: fake.client, draftId: 'd1', onsent, onclose: vi.fn() } });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(DRAFT.text));
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(onsent).toHaveBeenCalled());
    expect(fake.client.updateDraft).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ from: 'École <ecole@example.com>' }),
    );
  });

  it('the actions sit on the left, « Envoyer » first: the bottom-right corner belongs to Pina', async () => {
    const fake = fakeClient();
    const { container } = render(Composer, {
      props: { client: fake.client, onsent: vi.fn(), onclose: vi.fn() },
    });
    const bar = await waitFor(() => container.querySelector('.actions')!);
    expect(bar).toHaveClass('gauche');
    expect(bar.firstElementChild).toBe(screen.getByRole('button', { name: 'Envoyer' }));
  });

  it('a draft saves with « Enregistrer » and is thrown away only after confirming', async () => {
    const { client, user, onclose } = setup();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(DRAFT.text));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.updateDraft).toHaveBeenCalledTimes(1));
    expect(client.sendDraft).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Jeter' }));
    expect(client.deleteDraft).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', { name: 'Jeter le brouillon ?' });
    await user.click(within(dialog).getByRole('button', { name: 'Jeter' }));
    await waitFor(() => expect(client.deleteDraft).toHaveBeenCalledWith('d1'));
    expect(onclose).toHaveBeenCalled();
  });

  it('Enter in « Objet » or « À » sends nothing; only the click on « Envoyer » does', async () => {
    const { client, user, onsent } = setup();
    const subject = screen.getByRole('textbox', { name: 'Objet' });
    await waitFor(() => expect(subject).toHaveValue(DRAFT.subject));
    await user.type(subject, '{Enter}');
    await user.type(screen.getByRole('textbox', { name: 'À' }), '{Enter}');
    expect(client.sendDraft).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(onsent).toHaveBeenCalled());
    expect(client.sendDraft).toHaveBeenCalledWith('d1');
  });

  it('a new message: Enter in a field sends nothing, the click does', async () => {
    const fake = fakeClient();
    const onsent = vi.fn();
    render(Composer, { props: { client: fake.client, onsent, onclose: vi.fn() } });
    const user = userEvent.setup();
    const to = await screen.findByRole('textbox', { name: 'À' });
    await user.type(to, 'marie@example.com{Enter}');
    await user.type(screen.getByRole('textbox', { name: 'Objet' }), 'Salut{Enter}');
    expect(fake.client.send).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Envoyer' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    await waitFor(() => expect(onsent).toHaveBeenCalled());
    expect(fake.client.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'marie@example.com' }));
  });

  it('a new message shows no banner and sends as before', async () => {
    const fake = fakeClient();
    render(Composer, { props: { client: fake.client, onsent: vi.fn(), onclose: vi.fn() } });
    await screen.findByRole('form', { name: 'Nouveau message' });
    expect(screen.queryByText('Brouillon préparé par Pina.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Jeter' })).not.toBeInTheDocument();
    expect(fake.client.getDraft).not.toHaveBeenCalled();
  });
});
