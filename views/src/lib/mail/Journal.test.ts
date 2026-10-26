import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client.ts';
import { fakeClient } from '../../testing/fake-client.ts';
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
    const { user } = await open([entry(1, 'ai')], { onopen });
    (rowOf('Sujet 1').firstElementChild as HTMLElement).focus();
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
