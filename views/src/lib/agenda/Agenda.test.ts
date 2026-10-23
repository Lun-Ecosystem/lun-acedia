import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import type { AgendaItem } from '../types.ts';
import Agenda from './Agenda.svelte';
import ItemEditor from './ItemEditor.svelte';
import { title, type Editing } from './dates.ts';

// Instants built in the local zone of the test run, so the grid shows them at these hours.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

const ITEMS: AgendaItem[] = [
  {
    kind: 'event',
    id: 'lunch',
    calendarId: 'famille',
    title: 'Déjeuner avec Camille',
    start: at(21, 12, 30),
    end: at(21, 13, 30),
    allDay: false,
    location: 'Le Café des Arts',
    reminders: [30],
  },
  {
    kind: 'event',
    id: 'weekend',
    calendarId: 'perso',
    title: 'Week-end à Nantes',
    start: '2026-10-24',
    end: '2026-10-26',
    allDay: true,
    reminders: [],
  },
  // The same Google id in two calendars (an invitation seen from both): two separate events.
  {
    kind: 'event',
    id: 'dup',
    calendarId: 'perso',
    title: 'Revue A',
    start: at(22, 9),
    end: at(22, 10),
    allDay: false,
    reminders: [],
  },
  {
    kind: 'event',
    id: 'dup',
    calendarId: 'famille',
    title: 'Revue B',
    start: at(22, 9),
    end: at(22, 10),
    allDay: false,
    reminders: [],
  },
  {
    kind: 'task',
    id: 'tax',
    listId: 'list1',
    title: 'Payer la taxe foncière',
    due: '2026-10-20',
    done: false,
  },
];

async function open(items = ITEMS) {
  const { client } = fakeClient();
  client.agenda.mockResolvedValue(structuredClone(items));
  client.listCalendars.mockResolvedValue([
    { id: 'perso', title: 'Personnel' },
    { id: 'famille', title: 'Famille' },
  ]);
  client.listTaskLists.mockResolvedValue([{ id: 'list1', title: 'Mes tâches' }]);
  const user = userEvent.setup();
  // Wednesday 21 October 2026, 10:00.
  render(Agenda, { props: { client, today: new Date(2026, 9, 21, 10) } });
  await screen.findAllByText(items[0]!.title);
  return { client, user };
}

describe('period titles', () => {
  it('writes the week in French, lower case, across months and years', () => {
    expect(title('week', new Date(2026, 9, 21))).toBe('19 – 25 octobre 2026');
    expect(title('week', new Date(2026, 9, 28))).toBe('26 octobre – 1 novembre 2026');
    expect(title('week', new Date(2026, 11, 30))).toBe('28 décembre 2026 – 3 janvier 2027');
    expect(title('day', new Date(2026, 9, 21))).toBe('mercredi 21 octobre 2026');
    expect(title('month', new Date(2026, 9, 21))).toBe('octobre 2026');
  });
});

describe('Agenda', () => {
  it('titles the week « 19 – 25 octobre 2026 »', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: '19 – 25 octobre 2026' })).toBeInTheDocument();
  });

  it('opens the detail bubble on a click on an event', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: /Déjeuner avec Camille/ }));
    // jsdom measures nothing: the bubble layer stays `visibility: hidden`, so it has no accessible name.
    const bubble = await waitFor(() => {
      const found = document.querySelector('[role="dialog"][aria-label="Déjeuner avec Camille"]');
      if (!found) throw new Error('No bubble');
      return found;
    });
    expect(bubble).toHaveTextContent('mercredi 21 octobre · 12:30 – 13:30');
    expect(bubble).toHaveTextContent('Le Café des Arts');
    expect(bubble).toHaveTextContent('Rappel 30 min avant');
    expect(bubble).toHaveTextContent('Famille');
  });

  it('opens the creation with C', async () => {
    const { user } = await open();
    await user.keyboard('c');
    expect(await screen.findByRole('dialog', { name: 'Nouvel événement' })).toBeInTheDocument();
  });

  it('moves by period with J and K, and changes view with M and W', async () => {
    const { client, user } = await open();
    await user.keyboard('j');
    expect(
      await screen.findByRole('heading', { level: 1, name: '26 octobre – 1 novembre 2026' }),
    ).toBeInTheDocument();
    await user.keyboard('m');
    expect(await screen.findByRole('heading', { level: 1, name: 'octobre 2026' })).toBeInTheDocument();
    const [from, to] = client.agenda.mock.calls.at(-1)!;
    expect(from <= '2026-10-01' && to > '2026-10-31').toBe(true);
    await user.keyboard('w');
    expect(
      await screen.findByRole('heading', { level: 1, name: '26 octobre – 1 novembre 2026' }),
    ).toBeInTheDocument();
    await user.keyboard('t');
    expect(
      await screen.findByRole('heading', { level: 1, name: '19 – 25 octobre 2026' }),
    ).toBeInTheDocument();
  });

  it('shows all-day events and dated tasks in the band, and ticks a task where it stands', async () => {
    const { client, user } = await open();
    expect(screen.getByRole('button', { name: /Week-end à Nantes/ })).toBeInTheDocument();
    client.completeTask.mockResolvedValueOnce({
      ...(ITEMS[4] as Extract<AgendaItem, { kind: 'task' }>),
      done: true,
    });
    await user.click(screen.getByRole('checkbox', { name: 'Cocher Payer la taxe foncière' }));
    expect(client.completeTask).toHaveBeenCalledWith('list1', 'tax', true);
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Cocher Payer la taxe foncière' })).toBeChecked(),
    );
  });

  it('keeps the same event id of two calendars apart, and hides an unticked calendar', async () => {
    const { user } = await open();
    expect(screen.getByRole('button', { name: /Revue A/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Revue B/ })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Famille' }));
    expect(screen.queryByRole('button', { name: /Revue B/ })).toBeNull();
    expect(screen.queryByText('Déjeuner avec Camille')).toBeNull();
    expect(screen.getByRole('button', { name: /Revue A/ })).toBeInTheDocument();
  });

  it('creates an event from the window', async () => {
    const { client, user } = await open();
    client.saveEvent.mockImplementation(
      async (e) => ({ kind: 'event', id: 'new', reminders: [], ...e }) as never,
    );
    await user.click(screen.getByRole('button', { name: 'Créer' }));
    const editor = await screen.findByRole('dialog', { name: 'Nouvel événement' });
    await user.type(within(editor).getByLabelText('Titre'), 'Dentiste');
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.saveEvent).toHaveBeenCalled());
    expect(client.saveEvent.mock.calls[0]![0]).toMatchObject({
      calendarId: 'perso',
      title: 'Dentiste',
      allDay: false,
    });
  });

  it('switches the window to a task and saves it in a list', async () => {
    const { client, user } = await open();
    client.saveTask.mockImplementation(async (t) => ({ kind: 'task', id: 'n', done: false, ...t }) as never);
    await user.keyboard('c');
    const editor = await screen.findByRole('dialog', { name: 'Nouvel événement' });
    await user.click(within(editor).getByRole('radio', { name: 'Tâche' }));
    await user.type(within(editor).getByLabelText('Titre'), 'Rappeler le garage');
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.saveTask).toHaveBeenCalled());
    expect(client.saveTask.mock.calls[0]![0]).toMatchObject({
      listId: 'list1',
      title: 'Rappeler le garage',
      due: '2026-10-21',
    });
  });
});

describe('Agenda, fix round', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not read the same range again for T or a day picked inside the shown week', async () => {
    const { client, user } = await open();
    const reads = client.agenda.mock.calls.length;
    await user.keyboard('t');
    await user.click(screen.getByRole('button', { name: 'jeudi 22 octobre' }));
    expect(client.agenda.mock.calls.length).toBe(reads);
    await user.keyboard('j');
    await waitFor(() => expect(client.agenda.mock.calls.length).toBe(reads + 1));
  });

  it('follows the width: the planning below 768 px, the week above', async () => {
    let phone = false;
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return phone;
      },
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
      removeEventListener: () => {},
    }));
    await open();
    expect(screen.getByRole('heading', { level: 1, name: '19 – 25 octobre 2026' })).toBeInTheDocument();
    phone = true;
    listeners.forEach((fn) => fn({ matches: true }));
    expect(await screen.findByRole('heading', { level: 1, name: 'octobre 2026' })).toBeInTheDocument();
    phone = false;
    listeners.forEach((fn) => fn({ matches: false }));
    expect(
      await screen.findByRole('heading', { level: 1, name: '19 – 25 octobre 2026' }),
    ).toBeInTheDocument();
  });

  it('names the days of the all-day bars and of the band tasks', async () => {
    await open();
    expect(
      screen.getByRole('button', {
        name: 'Week-end à Nantes, journée entière, du samedi 24 octobre au dimanche 25 octobre',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Payer la taxe foncière, tâche du mardi 20 octobre' }),
    ).toBeInTheDocument();
  });

  it('shows both ends of a timed event over several days in the bubble', async () => {
    const trip: AgendaItem = {
      kind: 'event',
      id: 'trip',
      calendarId: 'perso',
      title: 'Voyage',
      start: at(23, 18),
      end: at(25, 18),
      allDay: false,
      reminders: [],
    };
    const { user } = await open([trip]);
    await user.click(screen.getAllByRole('button', { name: /Voyage/ })[0]!);
    const bubble = await waitFor(() => {
      const found = document.querySelector('[role="dialog"][aria-label="Voyage"]');
      if (!found) throw new Error('No bubble');
      return found;
    });
    expect(bubble).toHaveTextContent('vendredi 23 octobre 18:00 – dimanche 25 octobre 18:00');
  });
});

describe('ItemEditor', () => {
  // Friday 18:00 to Sunday 18:00, over the night the clocks go back.
  const trip: AgendaItem = {
    kind: 'event',
    id: 'trip',
    calendarId: 'perso',
    title: 'Week-end',
    start: at(23, 18),
    end: at(25, 18),
    allDay: false,
    reminders: [],
  };

  function edit(editing: Editing = trip) {
    const { client } = fakeClient();
    client.saveEvent.mockImplementation(async (e) => ({ ...trip, ...e }) as never);
    const user = userEvent.setup();
    render(ItemEditor, {
      props: {
        client,
        editing: structuredClone(editing),
        calendars: [{ id: 'perso', title: 'Personnel', color: 'var(--ok)' }],
        lists: [],
        onclose: () => {},
        onsaved: () => {},
        ondelete: () => {},
      },
    });
    return { client, user };
  }

  it('keeps the days of a timed event over several days when only its title changes', async () => {
    const { client, user } = edit();
    const editor = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    expect(within(editor).getByLabelText('Date de fin')).toHaveValue('2026-10-25');
    await user.type(within(editor).getByLabelText('Titre'), ' à Nantes');
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.saveEvent).toHaveBeenCalled());
    expect(client.saveEvent.mock.calls[0]![0]).toMatchObject({
      title: 'Week-end à Nantes',
      start: trip.start,
      end: (trip as Extract<AgendaItem, { kind: 'event' }>).end,
    });
  });

  it('moves the end of a timed event to another day', async () => {
    const { client, user } = edit();
    const editor = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    const end = within(editor).getByLabelText('Date de fin');
    await user.clear(end);
    await user.type(end, '2026-10-26');
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.saveEvent).toHaveBeenCalled());
    expect(client.saveEvent.mock.calls[0]![0]).toMatchObject({ start: trip.start, end: at(26, 18) });
  });

  async function rename(event: AgendaItem) {
    const { client, user } = edit(event);
    const editor = await screen.findByRole('dialog', { name: 'Modifier l’événement' });
    await user.type(within(editor).getByLabelText('Titre'), ' bis');
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.saveEvent).toHaveBeenCalled());
    return client.saveEvent.mock.calls[0]![0];
  }

  it('keeps the exact times of a zero-length event on a rename', async () => {
    const start = at(21, 9);
    const draft = await rename({ ...trip, start, end: start });
    expect(draft).toMatchObject({ title: 'Week-end bis', start, end: start });
  });

  it('keeps the exact times of an event in the hour repeated when the clocks go back', async () => {
    // 02:15 to 02:45 the second time, on 25 October 2026 in Paris (UTC+1 again).
    const event = { ...trip, start: '2026-10-25T01:15:00.000Z', end: '2026-10-25T01:45:00.000Z' };
    const draft = await rename(event);
    expect(draft).toMatchObject({ start: event.start, end: event.end });
  });

  it('gives a new timed event an end on another day', async () => {
    const { client, user } = edit({ kind: 'event', day: new Date(2026, 9, 23), hour: 18 });
    const editor = await screen.findByRole('dialog', { name: 'Nouvel événement' });
    await user.type(within(editor).getByLabelText('Titre'), 'Voyage');
    await user.click(within(editor).getByRole('button', { name: 'Date de fin' }));
    const end = within(editor).getByLabelText('Date de fin');
    await user.clear(end);
    await user.type(end, '2026-10-25');
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.saveEvent).toHaveBeenCalled());
    expect(client.saveEvent.mock.calls[0]![0]).toMatchObject({ start: at(23, 18), end: at(25, 19) });
  });
});
