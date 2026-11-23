import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client.ts';
import { agentIdentity } from '../pina/identity.svelte.ts';
import { fakeClient, LABELS } from '../../testing/fake-client.ts';
import type { JournalEntry, Origin } from '../types.ts';
import Journal from './Journal.svelte';

/** An instant `daysAgo` days back, at the local hour given. */
function at(daysAgo: number, hour: number, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const entry = (id: number, origin: Origin, extra: Partial<JournalEntry> = {}): JournalEntry => ({
  id,
  at: at(0, 10, 60 - id),
  messageId: `m${id}`,
  subject: `Sujet ${id}`,
  origin,
  action: 'file',
  before: ['INBOX'],
  after: ['L-ecole'],
  undoneAt: null,
  ...extra,
});

async function open(journal: JournalEntry[], props: Record<string, unknown> = {}) {
  const fake = fakeClient({ journal });
  const user = userEvent.setup();
  render(Journal, { props: { client: fake.client, ...props } });
  if (journal.length) await screen.findByText(journal[0]!.subject);
  return { ...fake, user };
}

const rowOf = (subject: string) => screen.getByText(subject).closest<HTMLElement>('li')!;
/** A button of a row, shown once the row has the keyboard (or the pointer, in a browser). */
function action(subject: string, name: string) {
  const row = rowOf(subject).firstElementChild as HTMLElement;
  row.focus();
  return within(row).getByRole('button', { name });
}
const subjects = () => screen.queryAllByRole('listitem').map((li) => li.querySelector('.objet')?.textContent);

describe('Journal', () => {
  it('groups the entries by day', async () => {
    await open([entry(1, 'ai'), entry(2, 'rule', { at: at(1, 18, 30) })]);
    const today = screen.getByRole('region', { name: 'Aujourd’hui' });
    const yesterday = screen.getByRole('region', { name: 'Hier' });
    expect(within(today).getByText('Sujet 1')).toBeInTheDocument();
    expect(within(yesterday).getByText('Sujet 2')).toBeInTheDocument();
  });

  it('shows the origin of each entry and where the mail went', async () => {
    await open([
      entry(1, 'ai'),
      entry(2, 'rule'),
      entry(3, 'user'),
      entry(4, 'ai', { action: 'spam', after: ['SPAM'] }),
      entry(5, 'ai', { action: 'trash', after: ['TRASH'] }),
    ]);
    expect(rowOf('Sujet 1')).toHaveTextContent('Rangé dans École par l’IA');
    expect(rowOf('Sujet 2')).toHaveTextContent('Rangé dans École par une règle');
    expect(rowOf('Sujet 3')).toHaveTextContent('Rangé dans École à la main');
    expect(rowOf('Sujet 4')).toHaveTextContent('Envoyé en Spam par l’IA');
    expect(rowOf('Sujet 5')).toHaveTextContent('Mis à la corbeille par l’IA');
    // The icon of the origin, named for screen readers.
    expect(within(rowOf('Sujet 1')).getByRole('img', { name: 'IA' })).toBeInTheDocument();
    expect(within(rowOf('Sujet 2')).getByRole('img', { name: 'Règle' })).toBeInTheDocument();
    expect(within(rowOf('Sujet 3')).getByRole('img', { name: 'À la main' })).toBeInTheDocument();
  });

  it('filters the loaded entries by origin and undone', async () => {
    const { user } = await open([
      entry(1, 'ai'),
      entry(2, 'rule'),
      entry(3, 'user'),
      entry(4, 'ai', { undoneAt: at(0, 10, 59) }),
    ]);
    const filters = screen.getByRole('group', { name: 'Filtrer le journal' });
    expect(within(filters).getByRole('button', { name: 'Tout' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(filters).getByRole('button', { name: 'IA' }));
    expect(subjects()).toEqual(['Sujet 1', 'Sujet 4']);
    await user.click(within(filters).getByRole('button', { name: 'Règles' }));
    expect(subjects()).toEqual(['Sujet 2']);
    await user.click(within(filters).getByRole('button', { name: 'Annulés' }));
    expect(subjects()).toEqual(['Sujet 4']);
    expect(rowOf('Sujet 4')).toHaveTextContent('Annulé');
    await user.click(within(filters).getByRole('button', { name: 'Tout' }));
    expect(subjects()).toEqual(['Sujet 1', 'Sujet 2', 'Sujet 3', 'Sujet 4']);
  });

  it('undoes an entry, which then shows as undone', async () => {
    const { client, user } = await open([entry(1, 'ai')]);
    client.undo.mockResolvedValueOnce({ id: 'm1', before: ['L-ecole'], after: ['INBOX'] });
    await user.click(action('Sujet 1', 'Annuler'));
    expect(client.undo).toHaveBeenCalledWith(1);
    await waitFor(() => expect(rowOf('Sujet 1')).toHaveTextContent(/annulé à \d\d:\d\d/));
    expect(within(rowOf('Sujet 1')).queryByRole('button', { name: 'Annuler' })).toBeNull();
  });

  it('explains a refused undo under its own row', async () => {
    const { client, user } = await open([entry(1, 'ai'), entry(2, 'ai')]);
    client.undo.mockRejectedValueOnce(new ApiError(409, 'Le mail a changé depuis, annulation refusée'));
    await user.click(action('Sujet 2', 'Annuler'));
    await waitFor(() =>
      expect(rowOf('Sujet 2')).toHaveTextContent('Le mail a changé depuis, annulation refusée'),
    );
    expect(rowOf('Sujet 1')).not.toHaveTextContent('annulation refusée');
    // Announced politely, in a region present before the message.
    const live = rowOf('Sujet 2').querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('annulation refusée');
    expect(rowOf('Sujet 1').querySelector('[aria-live="polite"]')).toBeEmptyDOMElement();
  });

  it('loads the older entries with « Plus ancien »', async () => {
    const fake = fakeClient();
    fake.client.journal
      .mockResolvedValueOnce({ items: [entry(5, 'ai')], cursor: 5 })
      .mockResolvedValueOnce({ items: [entry(3, 'rule', { at: at(3, 9) })] });
    const user = userEvent.setup();
    render(Journal, { props: { client: fake.client } });
    await screen.findByText('Sujet 5');
    await user.click(screen.getByRole('button', { name: 'Plus ancien' }));
    await screen.findByText('Sujet 3');
    expect(fake.client.journal).toHaveBeenLastCalledWith(5);
    expect(subjects()).toEqual(['Sujet 5', 'Sujet 3']);
    expect(screen.queryByRole('button', { name: 'Plus ancien' })).toBeNull();
  });

  it('opens the mail of an entry', async () => {
    const onopen = vi.fn();
    const { user } = await open([entry(1, 'ai')], { onopen });
    await user.click(action('Sujet 1', 'Ouvrir'));
    expect(onopen).toHaveBeenCalledWith('m1');
  });

  it('explains what will show when the journal is empty', async () => {
    const onsettings = vi.fn();
    const { user } = await open([], { onsettings });
    expect(await screen.findByRole('heading', { name: 'Rien pour l’instant' })).toBeInTheDocument();
    expect(screen.getByText(/l’action apparaît ici et peut être annulée/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Régler le seuil' }));
    expect(onsettings).toHaveBeenCalled();
  });

  it('says so when the journal cannot load', async () => {
    const fake = fakeClient();
    fake.client.journal.mockRejectedValueOnce(new Error('Gmail ne répond pas'));
    render(Journal, { props: { client: fake.client } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail ne répond pas');
  });

  it('keeps the hidden actions out of the Tab order until the row has the keyboard', async () => {
    const { user } = await open([entry(1, 'ai')], { onopen: vi.fn() });
    const row = rowOf('Sujet 1').firstElementChild as HTMLElement;
    const ouvrir = row.querySelector<HTMLElement>('.ouvrir')!;
    // Hidden by display: none, so neither shown, nor reachable with Tab, nor taking width.
    expect(ouvrir).not.toBeVisible();
    // display: none (not opacity): no Tab stop, no width taken from the subject.
    expect(getComputedStyle(ouvrir).display).toBe('none');
    // From the last filter, Tab reaches the row, not its hidden buttons.
    screen.getByRole('button', { name: 'Annulés' }).focus();
    await user.tab();
    expect(row).toHaveFocus();
    expect(ouvrir).toBeVisible();
  });

  it('opens the mail with Enter on the row', async () => {
    const onopen = vi.fn();
    const { user } = await open([entry(1, 'ai'), entry(2, 'rule', { undoneAt: at(0, 10, 59) })], { onopen });
    // A named focus stop: what happened to which mail.
    const row = screen.getByRole('group', { name: 'Sujet 1 : rangé dans École par l’IA' });
    expect(
      screen.getByRole('group', { name: 'Sujet 2 : rangé dans École par une règle, annulé à 10:59' }),
    ).toBeInTheDocument();
    row.focus();
    await user.keyboard('{Enter}');
    expect(onopen).toHaveBeenCalledWith('m1');
  });

  it('asks the server once for a double click on « Annuler »', async () => {
    const { client, user } = await open([entry(1, 'ai')]);
    let finish!: () => void;
    client.undo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ id: 'm1', before: ['L-ecole'], after: ['INBOX'] });
        }),
    );
    const button = action('Sujet 1', 'Annuler');
    await user.dblClick(button);
    finish();
    await waitFor(() => expect(rowOf('Sujet 1')).toHaveTextContent('annulé à'));
    expect(client.undo).toHaveBeenCalledTimes(1);
  });

  it('reads the journal again when the line was already undone elsewhere', async () => {
    const { client, user } = await open([entry(1, 'ai')]);
    client.undo.mockRejectedValueOnce(new ApiError(409, 'Action déjà annulée'));
    client.journal.mockResolvedValueOnce({ items: [entry(1, 'ai', { undoneAt: at(0, 10, 59) })] });
    await user.click(action('Sujet 1', 'Annuler'));
    await waitFor(() => expect(rowOf('Sujet 1')).toHaveTextContent('annulé à 10:59'));
    expect(rowOf('Sujet 1')).not.toHaveTextContent('Action déjà annulée');
    expect(client.journal).toHaveBeenCalledTimes(2);
  });

  it('asks the next page once while it loads, and retries it after a failure', async () => {
    const fake = fakeClient();
    let fail!: (err: Error) => void;
    fake.client.journal
      .mockResolvedValueOnce({ items: [entry(5, 'ai')], cursor: 5 })
      .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
      .mockResolvedValueOnce({ items: [entry(3, 'rule')] });
    const user = userEvent.setup();
    render(Journal, { props: { client: fake.client } });
    await screen.findByText('Sujet 5');
    await user.dblClick(screen.getByRole('button', { name: 'Plus ancien' }));
    expect(fake.client.journal).toHaveBeenCalledTimes(2);
    fail(new Error('Gmail ne répond pas'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail ne répond pas');
    expect(screen.getByText('Sujet 5')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await screen.findByText('Sujet 3');
    expect(fake.client.journal).toHaveBeenLastCalledWith(5);
  });

  it('never shows an empty journal while a failed first load is retried', async () => {
    const fake = fakeClient();
    fake.client.journal
      .mockRejectedValueOnce(new Error('Gmail ne répond pas'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(Journal, { props: { client: fake.client } });
    await user.click(await screen.findByRole('button', { name: 'Réessayer' }));
    expect(screen.getByLabelText('Chargement du journal')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Rien pour l’instant' })).toBeNull();
  });
});

/* Who decided, and what happened: plan 2026-11-23-journal-acedia, « Les textes, validés par CrOliX ». */
const BOXES = [
  ...LABELS,
  { id: 'L-factures', name: 'Factures', type: 'user' as const, role: 'box' as const },
  { id: 'L-voyages', name: 'Voyages', type: 'user' as const, role: 'box' as const },
  { id: 'L-news', name: 'Newsletters', type: 'user' as const, role: 'box' as const },
];

async function openWithBoxes(journal: JournalEntry[]) {
  const fake = fakeClient({ journal });
  fake.client.listLabels.mockResolvedValue(structuredClone(BOXES));
  const user = userEvent.setup();
  render(Journal, { props: { client: fake.client } });
  await screen.findByText(journal[0]!.subject);
  // The labels arrive after the lines: let them land before reading a box name.
  await waitFor(() => expect(fake.client.listLabels).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  return { ...fake, user };
}

afterEach(() => {
  agentIdentity.name = 'Agent';
});

const to = (box: string) => ({ before: ['INBOX'], after: [box] });
type Row = [string, Origin, string, Partial<JournalEntry>, string, string];
const CASES: Row[] = [
  ['1 AI files', 'ai', 'file', to('L-voyages'), 'Rangé dans Voyages par l’IA', 'IA'],
  ['1 AI spam', 'ai', 'spam', to('SPAM'), 'Envoyé en Spam par l’IA', 'IA'],
  ['1 AI trash', 'ai', 'trash', to('TRASH'), 'Mis à la corbeille par l’IA', 'IA'],
  [
    '2 validated to a box',
    'user',
    'validate',
    to('L-factures'),
    'Rangé dans Factures, proposition de l’IA validée',
    'IA',
  ],
  [
    '2 validated to spam',
    'user',
    'validate',
    to('SPAM'),
    'Envoyé en Spam, proposition de l’IA validée',
    'IA',
  ],
  [
    '2 validated, left in the inbox',
    'user',
    'validate',
    { before: ['INBOX'], after: ['INBOX'] },
    'Laissé en boîte de réception, proposition de l’IA validée',
    'IA',
  ],
  [
    '3 corrected to a box',
    'user',
    'correct',
    to('L-perso'),
    'Rangé dans Perso, proposition de l’IA corrigée',
    'À la main',
  ],
  [
    '3 corrected to the trash (INBOX kept)',
    'user',
    'correct',
    { before: ['INBOX'], after: ['INBOX', 'TRASH'] },
    'Mis à la corbeille, proposition de l’IA corrigée',
    'À la main',
  ],
  ['4 direct file', 'user', 'file', to('L-perso'), 'Rangé dans Perso à la main', 'À la main'],
  ['4 direct archive', 'user', 'archive', { before: ['INBOX'], after: [] }, 'Archivé à la main', 'À la main'],
  [
    '4 direct trash',
    'user',
    'trash',
    { before: ['INBOX'], after: ['INBOX', 'TRASH'] },
    'Mis à la corbeille à la main',
    'À la main',
  ],
  ['4 direct spam', 'user', 'spam', to('SPAM'), 'Envoyé en Spam à la main', 'À la main'],
  ['5 rule', 'rule', 'file', to('L-news'), 'Rangé dans Newsletters par une règle', 'Règle'],
  ['6 agent files', 'pina', 'file', to('L-perso'), 'Rangé dans Perso par Agent', 'Agent'],
  [
    '6 agent validates',
    'pina',
    'validate',
    to('L-factures'),
    'Rangé dans Factures, proposition de l’IA validée par Agent',
    'Agent',
  ],
  [
    '6 agent corrects',
    'pina',
    'correct',
    to('L-perso'),
    'Rangé dans Perso, proposition de l’IA corrigée par Agent',
    'Agent',
  ],
];

describe('Journal: who decided', () => {
  it.each(CASES)('%s', async (_name, origin, action, extra, text, icon) => {
    await openWithBoxes([entry(1, origin, { action, ...extra })]);
    expect(rowOf('Sujet 1')).toHaveTextContent(text);
    expect(within(rowOf('Sujet 1')).getByRole('img', { name: icon })).toBeInTheDocument();
  });

  it('7 an undone validation shows the time and the badge', async () => {
    await openWithBoxes([
      entry(1, 'user', {
        action: 'validate',
        ...to('L-factures'),
        at: at(0, 18, 30),
        undoneAt: at(0, 18, 41),
      }),
    ]);
    expect(rowOf('Sujet 1')).toHaveTextContent(
      'Rangé dans Factures, proposition de l’IA validée · annulé à 18:41',
    );
    expect(within(rowOf('Sujet 1')).getByText('Annulé')).toBeInTheDocument();
  });

  it('7 an undone line of a later day shows the date', async () => {
    await openWithBoxes([
      entry(1, 'user', { action: 'validate', ...to('L-factures'), at: at(3, 18, 30), undoneAt: at(0, 9, 0) }),
    ]);
    const day = new Date(at(0, 9, 0)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    expect(rowOf('Sujet 1')).toHaveTextContent(
      `Rangé dans Factures, proposition de l’IA validée · annulé le ${day}`,
    );
  });

  it('a correction to the box the mail came from is a filing, not an archive', async () => {
    await openWithBoxes([
      entry(1, 'user', { action: 'correct', before: ['INBOX', 'L-ecole'], after: ['L-ecole'] }),
    ]);
    expect(rowOf('Sujet 1')).toHaveTextContent('Rangé dans École, proposition de l’IA corrigée');
    expect(rowOf('Sujet 1')).not.toHaveTextContent('Archivé');
  });

  it('a validation that loses INBOX without a box is an archive, not « Laissé »', async () => {
    await openWithBoxes([entry(1, 'user', { action: 'validate', before: ['INBOX'], after: [] })]);
    expect(rowOf('Sujet 1')).toHaveTextContent('Archivé, proposition de l’IA validée');
    expect(rowOf('Sujet 1')).not.toHaveTextContent('Laissé en boîte de réception');
  });

  it('a manual file to the proposed box stays a direct gesture', async () => {
    await openWithBoxes([entry(1, 'user', { action: 'file', before: ['INBOX'], after: ['L-ecole'] })]);
    expect(rowOf('Sujet 1')).toHaveTextContent('Rangé dans École à la main');
    expect(rowOf('Sujet 1')).not.toHaveTextContent('proposition');
    expect(within(rowOf('Sujet 1')).getByRole('img', { name: 'À la main' })).toBeInTheDocument();
  });

  it('reads out the same text, word for word', async () => {
    await openWithBoxes([
      entry(1, 'user', {
        subject: 'Facture d’octobre',
        action: 'validate',
        ...to('L-factures'),
        at: at(0, 18, 30),
        undoneAt: at(0, 18, 41),
      }),
      entry(2, 'user', {
        subject: 'Nouveautés d’octobre',
        action: 'correct',
        before: ['INBOX'],
        after: ['INBOX', 'TRASH'],
      }),
      entry(3, 'pina', { subject: 'Photos du week-end', action: 'file', ...to('L-perso') }),
    ]);
    for (const name of [
      'Facture d’octobre : rangé dans Factures, proposition de l’IA validée, annulé à 18:41',
      'Nouveautés d’octobre : mis à la corbeille, proposition de l’IA corrigée',
      'Photos du week-end : rangé dans Perso par Agent',
    ])
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
  });

  describe('filters', () => {
    const rows = () => [
      entry(1, 'ai'),
      entry(2, 'user', { action: 'validate' }),
      entry(3, 'user', { action: 'correct' }),
      entry(4, 'user', { action: 'file' }),
      entry(5, 'user', { action: 'archive', after: [] }),
      entry(6, 'rule'),
      entry(7, 'pina'),
      entry(8, 'pina', { action: 'validate' }),
      entry(9, 'pina', { action: 'correct' }),
      entry(10, 'ai', { undoneAt: at(0, 10, 59) }),
    ];
    const group = () => screen.getByRole('group', { name: 'Filtrer le journal' });

    it('has six chips in order, the agent under its own name', async () => {
      agentIdentity.name = 'Lune';
      await openWithBoxes(rows());
      const names = within(group())
        .getAllByRole('button')
        .map((b) => b.textContent?.trim());
      expect(names).toEqual(['Tout', 'IA', 'À la main', 'Règles', 'Lune', 'Annulés']);
    });

    it.each([
      ['IA', ['Sujet 1', 'Sujet 2', 'Sujet 10']],
      ['À la main', ['Sujet 3', 'Sujet 4', 'Sujet 5']],
      ['Règles', ['Sujet 6']],
      ['Agent', ['Sujet 7', 'Sujet 8', 'Sujet 9']],
      ['Annulés', ['Sujet 10']],
    ])('%s keeps only its own lines', async (label, expected) => {
      const { user } = await openWithBoxes(rows());
      await user.click(within(group()).getByRole('button', { name: label }));
      expect(subjects()).toEqual(expected);
    });
  });
});
