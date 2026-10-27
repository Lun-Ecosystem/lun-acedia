import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../../testing/fake-client.ts';
import type { AgendaTask, LunEvent } from '../types.ts';
import Tasks from './Tasks.svelte';

const task = (id: string, title: string, extra: Partial<AgendaTask> = {}): AgendaTask => ({
  kind: 'task',
  id,
  listId: 'list1',
  title,
  done: false,
  ...extra,
});

const DATED: AgendaTask[] = [
  task('tax', 'Payer la taxe foncière', { due: '2026-10-20' }),
  task('bag', 'Préparer la valise', { due: '2026-10-23' }),
  task('spec', 'Relire la spec', { due: '2026-10-24', listId: 'list2' }),
  task('later', 'Changer les pneus', { due: '2026-11-12' }),
  task('bread', 'Acheter du pain', { due: '2026-10-21', done: true }),
];

const menuEntry = async (text: string) =>
  waitFor(() => {
    const entry = screen
      .queryAllByRole('menuitem', { hidden: true })
      .find((item) => item.textContent?.trim().startsWith(text));
    if (!entry) throw new Error(`No menu entry ${text}`);
    return entry;
  });

async function open() {
  const { client } = fakeClient();
  client.allTasks.mockResolvedValue([...structuredClone(DATED), task('news', 'Trier les newsletters')]);
  let listener: ((e: LunEvent) => void) | undefined;
  client.subscribe.mockImplementation((fn) => {
    listener = fn;
    return () => {};
  });
  client.listTaskLists.mockResolvedValue([
    { id: 'list1', title: 'Mes tâches' },
    { id: 'list2', title: 'Lun’' },
  ]);
  const user = userEvent.setup();
  // Wednesday 21 October 2026.
  render(Tasks, { props: { client, today: new Date(2026, 9, 21, 10) } });
  await screen.findByText('Payer la taxe foncière');
  const emit = (type: string) => listener?.({ id: '1', type, importance: 'info', at: '', title: '' });
  return { client, user, emit };
}

const group = (name: RegExp) => screen.getByRole('group', { name });

describe('Tasks', () => {
  it('groups the tasks by due date, the done ones folded', async () => {
    const { user } = await open();
    expect(screen.getByText('5 à faire, dont 1 en retard.', { exact: false })).toBeInTheDocument();
    expect(within(group(/En retard · 1/)).getByText('Payer la taxe foncière')).toBeInTheDocument();
    const week = group(/Cette semaine · 2/);
    expect(within(week).getByText('Préparer la valise')).toBeInTheDocument();
    expect(within(week).getByText('Relire la spec')).toBeInTheDocument();
    expect(within(group(/À venir · 1/)).getByText('Changer les pneus')).toBeInTheDocument();
    expect(within(group(/Sans date · 1/)).getByText('Trier les newsletters')).toBeInTheDocument();
    expect(screen.queryByText('Acheter du pain')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Terminées · 1/ }));
    expect(screen.getByText('Acheter du pain')).toBeInTheDocument();
  });

  it('adds a task in one line, with a date and a list', async () => {
    const { client, user } = await open();
    client.saveTask.mockImplementation(async (t) => ({ kind: 'task', id: 'n', done: false, ...t }) as never);
    await user.click(screen.getByRole('button', { name: 'Échéance : sans date' }));
    await user.click(await menuEntry('Demain'));
    await user.click(screen.getByRole('button', { name: 'Liste : Mes tâches' }));
    await user.click(await menuEntry('Lun’'));
    // The closing menu leaves the page inert for a moment: wait for it before typing.
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
    await user.type(screen.getByRole('textbox', { name: 'Nouvelle tâche' }), 'Rappeler le garage{Enter}');
    await waitFor(() => expect(client.saveTask).toHaveBeenCalled());
    expect(client.saveTask.mock.calls[0]![0]).toEqual({
      listId: 'list2',
      title: 'Rappeler le garage',
      due: '2026-10-22',
    });
    expect(await within(group(/Cette semaine · 3/)).findByText('Rappeler le garage')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nouvelle tâche' })).toHaveValue('');
  });

  it('ticks a task, which goes to the done ones', async () => {
    const { client, user } = await open();
    client.completeTask.mockResolvedValueOnce({ ...(DATED[1] as AgendaTask), done: true });
    await user.click(screen.getByRole('checkbox', { name: 'Cocher Préparer la valise' }));
    expect(client.completeTask).toHaveBeenCalledWith('list1', 'bag', true);
    expect(await screen.findByRole('button', { name: /Terminées · 2/ })).toBeInTheDocument();
  });

  it('shows one list from the rail', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('link', { name: /Lun’/ }));
    expect(screen.getByRole('heading', { level: 1, name: 'Lun’' })).toBeInTheDocument();
    expect(screen.queryByText('Payer la taxe foncière')).toBeNull();
    expect(screen.getByText('Relire la spec')).toBeInTheDocument();
  });

  it('reads the tasks only, once after a burst of server changes', async () => {
    const { client, emit } = await open();
    expect(client.agenda).not.toHaveBeenCalled();
    expect(client.allTasks).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      emit('agenda.changed');
      emit('agenda.changed');
      emit('mail.filed');
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }
    expect(client.allTasks).toHaveBeenCalledTimes(2);
  });

  it('says when the calendars cannot be read', async () => {
    const { client } = fakeClient();
    client.listCalendars.mockRejectedValue(new Error('Google ne répond pas'));
    render(Tasks, { props: { client, today: new Date(2026, 9, 21, 10) } });
    expect(await screen.findByText('Google ne répond pas')).toBeInTheDocument();
  });
});
