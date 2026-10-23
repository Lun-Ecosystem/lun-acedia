import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import type { MailSummary } from '../types.ts';
import { dismissAll } from '../ui/toasts.svelte.ts';
import Toaster from '../ui/Toaster.svelte';
import Pending from './Pending.svelte';

const proposed = (n: number, boxId: string, confidence: number, reason?: string): MailSummary => ({
  id: `m${n}`,
  threadId: `t${n}`,
  from: { name: `Expéditeur ${n}`, addr: `exp${n}@example.com` },
  subject: `Sujet ${n}`,
  snippet: `Aperçu ${n}`,
  date: `2026-11-02T0${n}:00:00.000Z`,
  unread: true,
  labels: ['INBOX', 'UNREAD'],
  proposal: { boxId, tagIds: [], confidence, status: 'pending', ...(reason ? { reason } : {}) },
});

/** École 72 and 88, Perso 90 and 85, Spam 70. */
const queue = () => [
  proposed(1, 'L-ecole', 72),
  proposed(2, 'L-perso', 90, 'Même expéditeur déjà rangé dans Perso.'),
  proposed(3, 'L-ecole', 88),
  proposed(4, 'spam', 70),
  proposed(5, 'L-perso', 85),
];

async function open(mails = queue()) {
  const fake = fakeClient({ mails });
  fake.client.getSettings.mockResolvedValue({ threshold: 95, bulkThreshold: 85 });
  const user = userEvent.setup();
  render(Pending, { props: { client: fake.client } });
  render(Toaster);
  if (mails.length) await screen.findByText('Sujet 1');
  return { ...fake, user };
}

const group = (name: string) => screen.getByRole('region', { name });
const subjects = (el: HTMLElement) =>
  within(el)
    .getAllByRole('article')
    .map((a) => a.querySelector('.objet')?.textContent);
// Role queries over the whole page are slow in jsdom: the panel is found by its attributes.
const correctPanel = () =>
  waitFor(() => {
    const panel = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Corriger la proposition"]',
    );
    if (!panel) throw new Error('No « Corriger » panel');
    return panel;
  });
// Unmeasured, the layer stays hidden in jsdom and its entries have no accessible name: found by text.
const option = (panel: HTMLElement, name: string) =>
  within(panel).getByText(name).closest('[role="option"]') as HTMLElement;
const remember = (panel: HTMLElement) =>
  within(panel)
    .getByText('Retenir pour cet expéditeur')
    .closest('label')!
    .querySelector('[role="checkbox"]')!;
const card = (subject: string) => screen.getByText(subject).closest('article') as HTMLElement;

describe('Pending', () => {
  afterEach(() => dismissAll());

  it('groups the proposals by proposed box, each group sorted by confidence', async () => {
    await open();
    expect(subjects(group('École'))).toEqual(['Sujet 3', 'Sujet 1']);
    expect(subjects(group('Perso'))).toEqual(['Sujet 2', 'Sujet 5']);
    expect(subjects(group('Spam'))).toEqual(['Sujet 4']);
    const order = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(order).toEqual(['Perso', 'École', 'Spam']);
    expect(screen.getByText('5 propositions sous le seuil de 95 %.', { exact: false })).toBeInTheDocument();
    expect(within(card('Sujet 2')).getByText('Même expéditeur déjà rangé dans Perso.')).toBeInTheDocument();
  });

  it('« Tout valider au-dessus de 85 % » validates only those at 85 % or more', async () => {
    const { client, user } = await open();
    await user.click(screen.getByRole('button', { name: /Tout valider au-dessus de 85/ }));
    await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(3));
    expect(client.validate.mock.calls.map(([id]) => id).sort()).toEqual(['m2', 'm3', 'm5']);
    await waitFor(() => expect(screen.queryByText('Sujet 2')).toBeNull());
    expect(screen.getByText('Sujet 1')).toBeInTheDocument();
    expect(screen.getByText('Sujet 4')).toBeInTheDocument();
  });

  it('V validates the active card and moves to the next one', async () => {
    const { client, user } = await open();
    expect(card('Sujet 2')).toHaveAttribute('aria-current', 'true');
    await user.keyboard('v');
    expect(client.validate).toHaveBeenCalledWith('m2');
    await waitFor(() => expect(card('Sujet 5')).toHaveAttribute('aria-current', 'true'));
    // Perso now tops at 85 %: École (88, 72) comes first, then Perso, then Spam.
    await user.keyboard('k');
    expect(card('Sujet 1')).toHaveAttribute('aria-current', 'true');
    await user.keyboard('v');
    expect(client.validate).toHaveBeenLastCalledWith('m1');
    await waitFor(() => expect(card('Sujet 5')).toHaveAttribute('aria-current', 'true'));
  });

  it('Shift+V validates the active group', async () => {
    const { client, user } = await open();
    await user.keyboard('j{Shift>}V{/Shift}');
    await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(2));
    expect(client.validate.mock.calls.map(([id]) => id)).toEqual(['m2', 'm5']);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Perso' })).toBeNull());
  });

  it('« Corriger »: « Retenir pour cet expéditeur » starts unticked', async () => {
    const { client, user } = await open();
    await user.click(within(card('Sujet 3')).getByRole('button', { name: /Corriger/ }));
    const panel = await correctPanel();
    expect(remember(panel)).not.toBeChecked();
    await user.click(option(panel, 'Perso'));
    await user.click(within(panel).getByText('Appliquer'));
    expect(client.correct).toHaveBeenCalledWith('m3', 'L-perso', [], { rememberSender: false });
  });

  it('« Corriger »: ticked, it asks to remember the sender', async () => {
    const { client, user } = await open();
    await user.click(within(card('Sujet 3')).getByRole('button', { name: /Corriger/ }));
    const panel = await correctPanel();
    await user.click(option(panel, 'Perso'));
    await user.click(remember(panel));
    await user.click(within(panel).getByText('Appliquer'));
    expect(client.correct).toHaveBeenCalledWith('m3', 'L-perso', [], { rememberSender: true });
  });

  it('« Corriger » towards the trash or spam does not offer to remember the sender', async () => {
    const { user } = await open();
    await user.click(within(card('Sujet 3')).getByRole('button', { name: /Corriger/ }));
    const panel = await correctPanel();
    await user.click(option(panel, 'Corbeille'));
    expect(panel.querySelector('[role="checkbox"]')).toBeNull();
    await user.click(option(panel, 'Spam'));
    expect(panel.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('an empty queue says « Rien à valider » with the figures of the day', async () => {
    const { client } = fakeClient({ mails: [] });
    client.todayStats.mockResolvedValue({ autoFiled: 14, validated: 4, corrected: 1 });
    render(Pending, { props: { client } });
    expect(await screen.findByText('Rien à valider')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('14')).toBeInTheDocument());
    expect(screen.getByText('rangés seuls aujourd’hui')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('validés')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('corrigé')).toBeInTheDocument();
  });
});
