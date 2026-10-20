import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import type { AgendaItem } from '../types.ts';
import Agenda from './Agenda.svelte';

const ITEMS: AgendaItem[] = [
  {
    kind: 'event',
    id: 'trip',
    calendarId: 'cal1',
    title: 'Voyage',
    start: '2026-11-02',
    end: '2026-11-04',
    allDay: true,
    reminders: [],
  },
  { kind: 'task', id: 'wed', listId: 'list1', title: 'Rendre le TP', due: '2026-11-04', done: false },
];

async function open() {
  const { client } = fakeClient();
  client.agenda.mockResolvedValue(structuredClone(ITEMS));
  const user = userEvent.setup();
  // Wednesday 4 November 2026.
  render(Agenda, { props: { client, today: new Date(2026, 10, 4, 10) } });
  await screen.findAllByText('Voyage');
  return { client, user };
}

const day = (name: string) => screen.getByRole('region', { name });

describe('Agenda', () => {
  it('shows a two-day event and a dated task on the right days of the week', async () => {
    await open();
    expect(within(day('lundi 2 novembre')).getByText('Voyage')).toBeInTheDocument();
    expect(within(day('mardi 3 novembre')).getByText('Voyage')).toBeInTheDocument();
    expect(within(day('mercredi 4 novembre')).queryByText('Voyage')).toBeNull();
    expect(within(day('mercredi 4 novembre')).getByText('Rendre le TP')).toBeInTheDocument();
  });

  it('ticks a task where it stands', async () => {
    const { client, user } = await open();
    client.completeTask.mockResolvedValueOnce({
      ...(ITEMS[1] as Extract<AgendaItem, { kind: 'task' }>),
      done: true,
    });
    await user.click(
      within(day('mercredi 4 novembre')).getByRole('checkbox', { name: 'Cocher Rendre le TP' }),
    );
    expect(client.completeTask).toHaveBeenCalledWith('list1', 'wed', true);
    await waitFor(() =>
      expect(
        within(day('mercredi 4 novembre')).getByRole('checkbox', { name: 'Cocher Rendre le TP' }),
      ).toBeChecked(),
    );
  });

  it('keeps the current date when switching from week to month and back', async () => {
    const { client, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: /Semaine du 9 novembre/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mois' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'novembre 2026' })).toBeInTheDocument();
    const [from, to] = client.agenda.mock.calls.at(-1)!;
    expect(from <= '2026-11-01' && to > '2026-11-30').toBe(true);
    await user.click(screen.getByRole('button', { name: 'Semaine' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: /Semaine du 9 novembre/ }),
    ).toBeInTheDocument();
  });

  it('creates an event from the editor', async () => {
    const { client, user } = await open();
    client.listCalendars.mockResolvedValue([{ id: 'cal1', title: 'Personnel' }]);
    client.saveEvent.mockImplementation(
      async (e) => ({ kind: 'event', id: 'new', reminders: [], ...e }) as never,
    );
    await user.click(screen.getByRole('button', { name: 'Nouvel événement' }));
    const editor = await screen.findByRole('dialog', { name: 'Événement' });
    await user.type(within(editor).getByLabelText('Titre'), 'Dentiste');
    await user.click(within(editor).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(client.saveEvent).toHaveBeenCalled());
    expect(client.saveEvent.mock.calls[0]![0]).toMatchObject({
      calendarId: 'cal1',
      title: 'Dentiste',
      allDay: false,
    });
  });
});
