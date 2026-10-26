import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../client.ts';
import { fakeClient } from '../../testing/fake-client.ts';
import { dismissAll } from '../ui/toasts.svelte.ts';
import Toaster from '../ui/Toaster.svelte';
import Mailbox from './Mailbox.svelte';

// jsdom measures nothing: the menu layer stays `visibility: hidden`, its entries are found by text.
const menuEntry = async (text: string) =>
  waitFor(() => {
    const entry = screen
      .queryAllByRole('menuitem', { hidden: true })
      .find((item) => item.textContent?.trim().startsWith(text));
    if (!entry) throw new Error(`No menu entry ${text}`);
    return entry;
  });

async function open() {
  const fake = fakeClient();
  const user = userEvent.setup();
  render(Mailbox, { props: { client: fake.client } });
  render(Toaster);
  const list = await screen.findByRole('group', { name: 'Mails' });
  await within(list).findByText('Sujet 1');
  const subjects = () =>
    within(list)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.objet')?.textContent);
  return { ...fake, user, list, subjects };
}

describe('Mailbox', () => {
  afterEach(() => dismissAll());

  it('without an open mail, no reading pane: the list takes the whole width', async () => {
    const { list } = await open();
    expect(screen.queryByRole('region', { name: 'Lecture' })).toBeNull();
    expect(list.closest('.liste')).not.toHaveClass('etroite');
  });

  it('opening a mail shows the reading pane, and Escape closes it', async () => {
    const { user, list, subjects } = await open();
    const before = subjects();
    expect(before).toHaveLength(5);
    await user.click(within(list).getByText('Sujet 2'));
    await screen.findByRole('region', { name: 'Lecture' });
    expect(list.closest('.liste')).toHaveClass('etroite');
    expect(subjects()).toEqual(before);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Lecture' })).toBeNull());
  });

  it('shows the mail in a sandboxed iframe, without scripts nor same origin', async () => {
    const { user, list } = await open();
    await user.click(within(list).getByText('Sujet 3'));
    const frame = (await screen.findByTitle('Contenu du mail')) as HTMLIFrameElement;
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-popups');
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('Corps de Sujet 3');
  });

  it('filing from the reader goes back to the list, already up to date', async () => {
    const { client, user, list, subjects } = await open();
    await user.click(within(list).getByText('Sujet 4'));
    const reader = await screen.findByRole('region', { name: 'Lecture' });
    await user.click(within(reader).getByRole('button', { name: 'Ranger dans' }));
    await user.click(await menuEntry('École'));
    expect(client.file).toHaveBeenCalledWith('m4', 'L-ecole');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Lecture' })).toBeNull());
    expect(subjects()).toEqual(['Sujet 1', 'Sujet 2', 'Sujet 3', 'Sujet 5']);
    expect(client.listMail.mock.calls.filter(([view]) => view === 'inbox')).toHaveLength(1);
  });

  it('validating a proposal from its row offers to undo it', async () => {
    const { client, user, list, subjects } = await open();
    const row = within(list).getAllByRole('listitem')[1]!;
    expect(row).toHaveTextContent('École · 72');
    client.undo.mockResolvedValueOnce({ id: 'm2', before: [], after: ['INBOX'] });
    await user.click(within(row).getByRole('button', { name: 'Valider : École' }));
    expect(client.validate).toHaveBeenCalledWith('m2');
    await waitFor(() => expect(subjects()).not.toContain('Sujet 2'));
    const toastText = await screen.findByText('Rangé dans École');
    const item = toastText.closest('.toast') as HTMLElement;
    await user.click(within(item).getByRole('button', { name: 'Annuler' }));
    const { journalId } = await client.validate.mock.results[0]!.value;
    expect(client.undo).toHaveBeenCalledWith(journalId);
  });

  it('the list is one Tab stop: the current row, then arrows and J, K move', async () => {
    const { user, list } = await open();
    const rows = () => [...list.querySelectorAll<HTMLElement>('.rangee')];
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([rows()[0]]);
    rows()[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows()[1]);
    await user.keyboard('j');
    expect(document.activeElement).toBe(rows()[2]);
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([rows()[2]]);
    await user.keyboard('{ArrowUp}{Enter}');
    expect(await screen.findByRole('region', { name: 'Lecture' })).toHaveTextContent('Sujet 2');
  });

  it('« Transférer » from « ⋯ » sends the mail under the message, subject « Tr : »', async () => {
    const { client, user, list } = await open();
    await user.click(within(list).getByText('Sujet 3'));
    const reader = await screen.findByRole('region', { name: 'Lecture' });
    await within(reader).findByTitle('Contenu du mail');
    await user.click(
      within(within(reader).getByRole('toolbar')).getByRole('button', { name: 'Plus d’actions' }),
    );
    await user.click(await menuEntry('Transférer'));
    const form = await screen.findByRole('form', { name: 'Transférer' });
    expect(within(form).getByDisplayValue('Tr : Sujet 3')).toBeInTheDocument();
    await user.type(within(form).getAllByRole('textbox')[0]!, 'ami@example.org');
    await user.click(within(form).getByRole('button', { name: /Envoyer/ }));
    await waitFor(() => expect(client.send).toHaveBeenCalled());
    const draft = client.send.mock.calls[0]![0];
    expect(draft.html).toContain('Message transféré');
    expect(draft.html).toContain('Corps de Sujet 3');
    expect(draft.html).not.toContain('Content-Security-Policy');
  });

  it('ticking two mails shows the selection bar', async () => {
    const { user, list } = await open();
    const boxes = within(list).getAllByRole('checkbox', { name: 'Sélectionner' });
    await user.click(boxes[0]!);
    await user.click(boxes[2]!);
    const bar = screen.getByRole('toolbar', { name: 'Actions groupées' });
    expect(bar).toHaveTextContent('2 sélectionnés');
  });

  it('puts the row back and says so when filing fails', async () => {
    const { client, user, list, subjects } = await open();
    client.file.mockRejectedValueOnce(new ApiError(502, 'Gmail ne répond pas'));
    await user.click(within(list).getByText('Sujet 4'));
    const reader = await screen.findByRole('region', { name: 'Lecture' });
    await user.click(within(reader).getByRole('button', { name: 'Ranger dans' }));
    await user.click(await menuEntry('Perso'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail ne répond pas');
    expect(subjects()).toEqual(['Sujet 1', 'Sujet 2', 'Sujet 3', 'Sujet 4', 'Sujet 5']);
  });
});
