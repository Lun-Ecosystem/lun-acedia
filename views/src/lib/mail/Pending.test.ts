import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { agentIdentity } from '../pina/identity.svelte.ts';
import { fakeClient } from '../../testing/fake-client.ts';
import type { LunEvent, MailSummary } from '../types.ts';
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

async function open(mails = queue(), prepare?: (fake: ReturnType<typeof fakeClient>) => void) {
  const fake = fakeClient({ mails });
  fake.client.getSettings.mockResolvedValue({ threshold: 95, bulkThreshold: 85 });
  prepare?.(fake);
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
const ZERO = { autoFiled: 0, ai: 0, rule: 0, validated: 0, corrected: 0, refused: 0, agent: 0 };
// « 14 » and its words, glued: `<b>` and the text are siblings.
const tiles = () =>
  [...document.querySelectorAll('.stat')].map((t) =>
    t.textContent
      ?.replace(/\s+/g, ' ')
      .trim()
      .replace(/^(\d+) /, '$1'),
  );
const card = (subject: string) => screen.getByText(subject).closest('article') as HTMLElement;

describe('Pending', () => {
  afterEach(() => {
    dismissAll();
    agentIdentity.name = 'Agent';
  });

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
    client.todayStats.mockResolvedValue({ ...ZERO, autoFiled: 14, ai: 14, validated: 4, corrected: 1 });
    render(Pending, { props: { client } });
    expect(await screen.findByText('Rien à valider')).toBeInTheDocument();
    await waitFor(() => expect(tiles()).toHaveLength(3));
    expect(tiles()).toEqual(['14rangés seuls par l’IA aujourd’hui', '4validés', '1corrigé']);
  });

  it('shows the six tiles in order, the agent under its own name, « aujourd’hui » on the first', async () => {
    agentIdentity.name = 'Lune';
    const { client } = fakeClient({ mails: [] });
    client.todayStats.mockResolvedValue({
      autoFiled: 9,
      ai: 5,
      rule: 4,
      validated: 3,
      corrected: 2,
      refused: 6,
      agent: 7,
    });
    render(Pending, { props: { client } });
    await waitFor(() => expect(tiles()).toHaveLength(6));
    expect(tiles()).toEqual([
      '5rangés seuls par l’IA aujourd’hui',
      '4par une règle',
      '3validés',
      '2corrigés',
      '6refusés',
      '7par Lune',
    ]);
  });

  it('puts the singular on the tiles at one', async () => {
    const { client } = fakeClient({ mails: [] });
    client.todayStats.mockResolvedValue({ ...ZERO, ai: 1, validated: 1, corrected: 1, refused: 1 });
    render(Pending, { props: { client } });
    await waitFor(() => expect(tiles()).toHaveLength(4));
    expect(tiles()).toEqual(['1rangé seul par l’IA aujourd’hui', '1validé', '1corrigé', '1refusé']);
  });

  it('hides the tiles at zero: « aujourd’hui » moves to the first one shown', async () => {
    const { client } = fakeClient({ mails: [] });
    client.todayStats.mockResolvedValue({ ...ZERO, validated: 4, refused: 2 });
    render(Pending, { props: { client } });
    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(tiles()).toEqual(['4validés aujourd’hui', '2refusés']);
  });

  it('shows no tile when everything is at zero', async () => {
    const { client } = fakeClient({ mails: [] });
    render(Pending, { props: { client } });
    await screen.findByText('Rien à valider');
    await waitFor(() => expect(client.todayStats).toHaveBeenCalled());
    await client.todayStats.mock.results[0]!.value;
    expect(tiles()).toEqual([]);
  });

  describe('« Refuser la proposition »', () => {
    const refuseButton = (subject: string) =>
      within(card(subject)).queryByRole('button', { name: 'Refuser la proposition' });

    it('is on every card proposed to a box, the trash or spam', async () => {
      await open();
      for (const n of [1, 2, 3, 4, 5]) expect(refuseButton(`Sujet ${n}`)).toBeInTheDocument();
    });

    it('is absent from a card without a proposed box, which keeps « Valider » and « Corriger »', async () => {
      const bare = proposed(1, 'L-ecole', 72);
      bare.proposal = { ...bare.proposal!, boxId: null };
      await open([bare, proposed(2, 'L-ecole', 90)]);
      expect(refuseButton('Sujet 1')).toBeNull();
      expect(refuseButton('Sujet 2')).toBeInTheDocument();
      expect(within(card('Sujet 1')).getByRole('button', { name: 'Valider' })).toBeInTheDocument();
      expect(within(card('Sujet 1')).getByRole('button', { name: /Corriger/ })).toBeInTheDocument();
    });

    it('refuses, takes the card off the queue and says so', async () => {
      const { client, user } = await open();
      await user.click(refuseButton('Sujet 3')!);
      expect(client.refuse).toHaveBeenCalledWith('m3');
      expect(client.validate).not.toHaveBeenCalled();
      expect(await screen.findByText('Proposition refusée : Expéditeur 3')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('Sujet 3')).toBeNull());
    });

    it('« Annuler » in the toast undoes the journal line and brings the proposal back', async () => {
      const { client, mails, user } = await open();
      client.undo.mockImplementation(async () => {
        mails.find((m) => m.id === 'm3')!.proposal!.status = 'pending';
        return { id: 'm3', before: ['INBOX'], after: ['INBOX'] };
      });
      await user.click(refuseButton('Sujet 3')!);
      await screen.findByText('Proposition refusée : Expéditeur 3');
      // The journal id the refusal answered with.
      const { journalId } = await client.refuse.mock.results[0]!.value;
      await user.click(screen.getByRole('button', { name: 'Annuler' }));
      expect(client.undo).toHaveBeenCalledWith(journalId);
      expect(await screen.findByText('Sujet 3')).toBeInTheDocument();
    });

    it('leaves the keyboard on the next card, as after V', async () => {
      const { user } = await open([proposed(1, 'L-ecole', 72), proposed(2, 'L-ecole', 90)]);
      expect(card('Sujet 2')).toHaveAttribute('aria-current', 'true');
      await user.click(refuseButton('Sujet 2')!);
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 1')));
    });
  });

  it('does not list a pending mail that went to the trash or spam while keeping INBOX', async () => {
    const trashed = proposed(1, 'L-ecole', 72);
    trashed.labels = ['INBOX', 'TRASH'];
    const spammed = proposed(2, 'L-ecole', 80);
    spammed.labels = ['INBOX', 'SPAM'];
    const { client } = fakeClient({ mails: [trashed, spammed, proposed(3, 'L-ecole', 90)] });
    client.getSettings.mockResolvedValue({ threshold: 95, bulkThreshold: 85 });
    render(Pending, { props: { client } });
    await screen.findByText('Sujet 3');
    expect(screen.queryByText('Sujet 1')).toBeNull();
    expect(screen.queryByText('Sujet 2')).toBeNull();
  });

  it('« Tout valider » compares the real confidence: 84.5 % is under 85 %', async () => {
    const { client, user } = await open([proposed(1, 'L-ecole', 84.5), proposed(2, 'L-ecole', 85)]);
    expect(card('Sujet 1').querySelector('.valeur')).toHaveTextContent(/84\s%/);
    await user.click(screen.getByRole('button', { name: /Tout valider au-dessus de 85/ }));
    await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(1));
    expect(client.validate).toHaveBeenCalledWith('m2');
  });

  it('after V the keyboard is on the next card; the last one leaves it on the emptied queue', async () => {
    const { user } = await open([proposed(1, 'L-ecole', 72), proposed(2, 'L-ecole', 90)]);
    await user.keyboard('v');
    await waitFor(() => expect(document.activeElement).toBe(card('Sujet 1')));
    await user.click(within(card('Sujet 1')).getByRole('button', { name: 'Valider' }));
    const title = await screen.findByText('Rien à valider');
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it('after « Corriger », the keyboard is on the next card', async () => {
    const { user } = await open();
    await user.click(within(card('Sujet 2')).getByRole('button', { name: /Corriger/ }));
    const panel = await correctPanel();
    await user.click(within(panel).getByText('Appliquer'));
    await waitFor(() => expect(document.activeElement).toBe(card('Sujet 5')));
  });

  it('reloads once after a batch, not for each mail of it', async () => {
    let emit: (e: LunEvent) => void = () => {};
    const event = { id: '1', type: 'mail.filed', importance: 'info', at: '', title: '' } as const;
    const { client, user } = await open(queue(), ({ client }) => {
      client.subscribe.mockImplementation((fn) => ((emit = fn), () => {}));
      const run = client.validate.getMockImplementation()!;
      client.validate.mockImplementation(async (id) => {
        const done = await run(id);
        emit(event);
        return done;
      });
    });
    const pending = () => client.listMail.mock.calls.filter(([view]) => view === 'pending').length;
    expect(pending()).toBe(1);
    await user.click(screen.getByRole('button', { name: /Tout valider au-dessus de 85/ }));
    await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(pending()).toBe(2));
  });

  it('a change arriving under the open « Corriger » panel is shown once it closes', async () => {
    let emit: (e: LunEvent) => void = () => {};
    const { client, user } = await open(queue(), ({ client }) => {
      client.subscribe.mockImplementation((fn) => ((emit = fn), () => {}));
    });
    const pending = () => client.listMail.mock.calls.filter(([view]) => view === 'pending').length;
    await user.click(within(card('Sujet 3')).getByRole('button', { name: /Corriger/ }));
    const panel = await correctPanel();
    emit({ id: '1', type: 'mail.filed', importance: 'info', at: '', title: '' });
    expect(pending()).toBe(1);
    await user.click(within(panel).getByText('Annuler'));
    await waitFor(() => expect(pending()).toBe(2));
  });
});
