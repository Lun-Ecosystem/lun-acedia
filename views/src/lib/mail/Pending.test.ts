import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../client.ts';
import { agentIdentity } from '../pina/identity.svelte.ts';
import { fakeClient } from '../../testing/fake-client.ts';
import type { LunEvent, MailSummary } from '../types.ts';
import { dismissAll } from '../ui/toasts.svelte.ts';
import Toaster from '../ui/Toaster.svelte';
import Pending from './Pending.svelte';

/** `bulk` as the server sets it for the test's lines (threshold 95, bulk 85): at 85 % or more. */
const proposed = (n: number, boxId: string, confidence: number, reason?: string): MailSummary => ({
  id: `m${n}`,
  threadId: `t${n}`,
  from: { name: `Expéditeur ${n}`, addr: `exp${n}@example.com` },
  subject: `Sujet ${n}`,
  snippet: `Aperçu ${n}`,
  date: `2026-11-02T0${n}:00:00.000Z`,
  unread: true,
  labels: ['INBOX', 'UNREAD'],
  proposal: {
    boxId,
    tagIds: [],
    confidence,
    status: 'pending',
    ...(reason ? { reason } : {}),
    ...(confidence >= 85 ? { bulk: true as const } : {}),
  },
});

/** École 72 and 88, Perso 90 and 85, Spam 70. */
const queue = () => [
  proposed(1, 'L-ecole', 72),
  proposed(2, 'L-perso', 90, 'Même expéditeur déjà rangé dans Perso.'),
  proposed(3, 'L-ecole', 88),
  proposed(4, 'spam', 70),
  proposed(5, 'L-perso', 85),
];

async function open(
  mails = queue(),
  prepare?: (fake: ReturnType<typeof fakeClient>) => void,
  props: { onopen?: (id: string) => void } = {},
) {
  const fake = fakeClient({ mails });
  fake.client.getSettings.mockResolvedValue({ threshold: 95, bulkThreshold: 85 });
  prepare?.(fake);
  const user = userEvent.setup();
  render(Pending, { props: { client: fake.client, ...props } });
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
/** Puts the focus on a card the way Tab or a click does, and lets the screen settle. */
async function focusCard(subject: string) {
  card(subject).focus();
  await tick();
}
const button = (subject: string, name: string | RegExp) =>
  within(card(subject)).getByRole('button', { name });
/** A beat for something that must NOT happen to have had the time to happen. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));
const noPanel = () =>
  document.querySelector('[role="dialog"][aria-label="Corriger la proposition"]') === null;
const lit = () => document.querySelectorAll('article[aria-current="true"]');

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

  it('« Tout valider » takes the `bulk` of the server, whatever the confidence says', async () => {
    const trusted = proposed(1, 'L-ecole', 40);
    trusted.proposal!.bulk = true;
    const doubted = proposed(2, 'L-ecole', 99);
    delete doubted.proposal!.bulk;
    const { client, user } = await open([trusted, doubted]);
    await user.click(screen.getByRole('button', { name: /Tout valider au-dessus de 85/ }));
    await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(1));
    expect(client.validate).toHaveBeenCalledWith('m1');
  });

  it('« Tout valider » is disabled without any `bulk`, its label keeping the line of the settings', async () => {
    const { client } = await open([proposed(1, 'L-ecole', 72), proposed(2, 'L-ecole', 80)]);
    expect(screen.getByRole('button', { name: /Tout valider au-dessus de 85/ })).toBeDisabled();
    expect(client.validate).not.toHaveBeenCalled();
  });

  it('V validates the active card and moves to the next one', async () => {
    const { client, user } = await open();
    await focusCard('Sujet 2');
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
      await focusCard('Sujet 2');
      expect(card('Sujet 2')).toHaveAttribute('aria-current', 'true');
      await user.click(refuseButton('Sujet 2')!);
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 1')));
    });
  });

  // The server's own proof is in `routes.test.ts`: this one keeps the fake client in line with it.
  it('the fake client leaves out of the queue a mail in the trash or spam that keeps INBOX', async () => {
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
    await focusCard('Sujet 2');
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

  describe('the keyboard follows the focus', () => {
    it('lights no card at load', async () => {
      await open();
      expect(lit()).toHaveLength(0);
    });

    it('at load, V, Shift+V and C do nothing', async () => {
      const { client, user } = await open();
      await user.keyboard('v');
      await user.keyboard('{Shift>}V{/Shift}');
      await user.keyboard('c');
      await settled();
      expect(client.validate).not.toHaveBeenCalled();
      expect(client.correct).not.toHaveBeenCalled();
      expect(noPanel()).toBe(true);
    });

    it('J without focus gives the focus to the first card, and calls nothing', async () => {
      const { client, user } = await open();
      await user.keyboard('j');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 2')));
      expect(client.validate).not.toHaveBeenCalled();
    });

    it('K without focus gives the focus to the first card, and calls nothing', async () => {
      const { client, user } = await open();
      await user.keyboard('k');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 2')));
      expect(client.validate).not.toHaveBeenCalled();
    });

    it('after a gesture then a click outside the cards, J brings the focus back to the Tab stop', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 2');
      await user.keyboard('v');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 5')));
      await user.click(group('École').querySelector('h2')!);
      expect(document.activeElement).not.toBe(card('Sujet 5'));
      await user.keyboard('j');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 5')));
      expect(client.validate).toHaveBeenCalledTimes(1);
    });

    it('V validates the card holding the focus, and only it', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 3');
      await user.keyboard('v');
      await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(1));
      expect(client.validate).toHaveBeenCalledWith('m3');
    });

    it('Shift+V validates the group of the card holding the focus', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 5');
      await user.keyboard('{Shift>}V{/Shift}');
      await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(2));
      expect(client.validate.mock.calls.map(([id]) => id)).toEqual(['m2', 'm5']);
    });

    it('C opens « Corriger » on the card holding the focus', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 3');
      await user.keyboard('c');
      const panel = await correctPanel();
      await user.click(option(panel, 'Perso'));
      await user.click(within(panel).getByText('Appliquer'));
      expect(client.correct).toHaveBeenCalledWith('m3', 'L-perso', [], { rememberSender: false });
    });

    it('J and K move the focus from the card holding it', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 5');
      await user.keyboard('j');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 3')));
      expect(card('Sujet 3')).toHaveAttribute('aria-current', 'true');
      await user.keyboard('k');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 5')));
      expect(client.validate).not.toHaveBeenCalled();
    });

    it('with the focus out of the cards (a click on a title), V calls nothing', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 2');
      await user.click(group('École').querySelector('h2')!);
      await user.keyboard('v');
      await settled();
      expect(client.validate).not.toHaveBeenCalled();
    });

    it('V from a button validates that button’s card; the next V the card after it, never the earlier one', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 2');
      button('Sujet 3', 'Valider').focus();
      await tick();
      await user.keyboard('v');
      await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(1));
      expect(client.validate).toHaveBeenLastCalledWith('m3');
      // École is now Sujet 1 alone: the card after Sujet 3.
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 1')));
      await user.keyboard('v');
      await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(2));
      expect(client.validate).toHaveBeenLastCalledWith('m1');
      expect(client.validate.mock.calls.map(([id]) => id)).not.toContain('m2');
    });

    it('a repeated V calls nothing: holding the key validates one card', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 2');
      await user.keyboard('v');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 5')));
      for (let i = 0; i < 3; i++)
        await fireEvent.keyDown(document.activeElement!, { key: 'v', repeat: true });
      await settled();
      expect(client.validate).toHaveBeenCalledTimes(1);
    });

    it('a card brought back by « Annuler » is not settled by V while the focus is not on it', async () => {
      const { client, mails, user } = await open();
      client.undo.mockImplementation(async () => {
        mails.find((m) => m.id === 'm3')!.proposal!.status = 'pending';
        return { id: 'm3', before: ['INBOX'], after: ['INBOX'] };
      });
      await focusCard('Sujet 3');
      await user.click(button('Sujet 3', 'Refuser la proposition'));
      await screen.findByText('Proposition refusée : Expéditeur 3');
      await user.click(screen.getByRole('button', { name: 'Annuler' }));
      await screen.findByText('Sujet 3');
      await user.keyboard('v');
      await settled();
      expect(client.validate).not.toHaveBeenCalled();
    });
  });

  describe('the edges of the keyboard', () => {
    it('a card brought back by « Annuler » is not lit', async () => {
      const { client, mails, user } = await open([proposed(1, 'L-ecole', 72)]);
      client.undo.mockImplementation(async () => {
        mails.find((m) => m.id === 'm1')!.proposal!.status = 'pending';
        return { id: 'm1', before: ['INBOX'], after: ['INBOX'] };
      });
      await focusCard('Sujet 1');
      await user.click(button('Sujet 1', 'Refuser la proposition'));
      await screen.findByText('Proposition refusée : Expéditeur 1');
      await user.click(screen.getByRole('button', { name: 'Annuler' }));
      await screen.findByText('Sujet 1');
      expect(lit()).toHaveLength(0);
    });

    it('K without focus puts the focus back on the Tab stop and moves nothing', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 3');
      await user.click(group('Spam').querySelector('h2')!);
      expect(document.activeElement).not.toBe(card('Sujet 3'));
      await user.keyboard('k');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 3')));
      expect(client.validate).not.toHaveBeenCalled();
    });

    it('with « Corriger » open, V calls nothing', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 3');
      await user.keyboard('c');
      await correctPanel();
      await fireEvent.keyDown(card('Sujet 3'), { key: 'v' });
      await user.keyboard('v');
      await settled();
      expect(client.validate).not.toHaveBeenCalled();
    });

    it('V from a button outside the cards (the « Valider » of a group, focused) calls nothing', async () => {
      const { client, user } = await open();
      const head = group('Perso').querySelector('header') as HTMLElement;
      within(head)
        .getByRole('button', { name: /^Valider/ })
        .focus();
      await tick();
      await user.keyboard('v');
      await settled();
      expect(client.validate).not.toHaveBeenCalled();
    });

    it('J from the « Valider » of a card goes to the next card', async () => {
      const { client, user } = await open();
      await focusCard('Sujet 2');
      button('Sujet 2', 'Valider').focus();
      await tick();
      await user.keyboard('j');
      await waitFor(() => expect(document.activeElement).toBe(card('Sujet 5')));
      expect(client.validate).not.toHaveBeenCalled();
    });
  });

  describe('the hints say where a key acts', () => {
    it('the « ↵ » of the eye is announced from the card or the eye, not from another button', async () => {
      await open(queue(), undefined, { onopen: () => {} });
      const eye = () => button('Sujet 2', 'Ouvrir le mail');
      button('Sujet 2', 'Valider').focus();
      await tick();
      expect(eye()).not.toHaveAttribute('aria-keyshortcuts');
      await focusCard('Sujet 2');
      expect(eye()).toHaveAttribute('aria-keyshortcuts', '↵');
      eye().focus();
      await tick();
      expect(eye()).toHaveAttribute('aria-keyshortcuts', '↵');
    });

    it('every card announces « V Shift+V C »; its buttons keep « V » and « C »', async () => {
      await open();
      for (const n of [1, 2, 3, 4, 5]) {
        const s = `Sujet ${n}`;
        expect(card(s)).toHaveAttribute('aria-keyshortcuts', 'V Shift+V C');
        expect(button(s, 'Valider')).toHaveAttribute('aria-keyshortcuts', 'V');
        expect(button(s, 'Corriger')).toHaveAttribute('aria-keyshortcuts', 'C');
      }
    });

    it('the « Valider » of a group no longer announces Shift+V', async () => {
      await open();
      for (const name of ['Perso', 'École', 'Spam']) {
        const head = group(name).querySelector('header') as HTMLElement;
        expect(within(head).getByRole('button', { name: /^Valider/ })).not.toHaveAttribute(
          'aria-keyshortcuts',
        );
      }
    });
  });

  describe('what the keyboard rule leaves as it was', () => {
    it('« Valider » of a group validates the group, with no focus before', async () => {
      const { client, user } = await open();
      const head = group('Perso').querySelector('header') as HTMLElement;
      await user.click(within(head).getByRole('button', { name: /^Valider/ }));
      await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(2));
      expect(client.validate.mock.calls.map(([id]) => id)).toEqual(['m2', 'm5']);
    });

    it('« Valider » of a card validates that card, with no focus before', async () => {
      const { client, user } = await open();
      await user.click(button('Sujet 4', 'Valider'));
      await waitFor(() => expect(client.validate).toHaveBeenCalledTimes(1));
      expect(client.validate).toHaveBeenCalledWith('m4');
    });

    it('a card slid to the right validates, a finger on it (touch)', async () => {
      const { client } = await open();
      const el = card('Sujet 3');
      const touch = { pointerType: 'touch', pointerId: 1, bubbles: true };
      await fireEvent.pointerDown(el, { ...touch, clientX: 10 });
      await fireEvent.pointerMove(el, { ...touch, clientX: 150 });
      await fireEvent.pointerUp(el, { ...touch, clientX: 150 });
      await waitFor(() => expect(client.validate).toHaveBeenCalledWith('m3'));
    });

    it('a 409 says the server’s words and takes the card off the queue', async () => {
      const { client, mails, user } = await open();
      client.validate.mockImplementationOnce(async (id) => {
        // The other gesture settled it.
        mails.find((m) => m.id === id)!.proposal!.status = 'accepted';
        throw new ApiError(409, 'Un geste est déjà en cours sur ce mail');
      });
      await user.click(button('Sujet 3', 'Valider'));
      expect(await screen.findByText('Un geste est déjà en cours sur ce mail')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('Sujet 3')).toBeNull());
    });
  });
});
