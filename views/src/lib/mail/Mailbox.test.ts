import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client.ts';
import { fakeClient, fiveMails } from '../../testing/fake-client.ts';
import ShellFixture from '../../testing/ShellFixture.svelte';
import type { ScreenParts } from '../ui/shell.ts';
import type { LunEvent, MailSummary } from '../types.ts';
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

  it('an empty inbox says what the sort filed today and links to the Journal', async () => {
    const fake = fakeClient();
    fake.client.listMail.mockResolvedValue({ items: [] });
    fake.client.todayStats.mockResolvedValue({
      autoFiled: 3,
      ai: 3,
      rule: 0,
      validated: 0,
      corrected: 0,
      refused: 0,
      agent: 0,
    });
    const onjournal = vi.fn();
    render(Mailbox, { props: { client: fake.client, onjournal } });
    expect(await screen.findByText('La réception est vide')).toBeInTheDocument();
    expect(
      await screen.findByText('Le tri a rangé 3 mails aujourd’hui dans leurs boîtes.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Voir le journal' }));
    expect(onjournal).toHaveBeenCalledOnce();
  });

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

  // The row shows its actions on hover only: `aria-expanded` is what keeps them, and the menu's anchor, while
  // the menu is open (ListRow).
  it('« Ranger dans » from a row marks its button open while the menu is, and files the mail', async () => {
    const { client, user, list, subjects } = await open();
    const row = within(list).getByText('Sujet 4').closest('li')!;
    const button = within(row).getByRole('button', { name: 'Ranger dans' });
    await user.click(button);
    const entry = await menuEntry('École');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await user.click(entry);
    expect(client.file).toHaveBeenCalledWith('m4', 'L-ecole');
    expect(subjects()).toEqual(['Sujet 1', 'Sujet 2', 'Sujet 3', 'Sujet 5']);
  });

  it('Escape closes « Ranger dans » of a row, and its button is no longer marked open', async () => {
    const { client, user, list } = await open();
    const row = within(list).getByText('Sujet 2').closest('li')!;
    const button = within(row).getByRole('button', { name: 'Ranger dans' });
    await user.click(button);
    await menuEntry('École');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(button.hasAttribute('aria-expanded')).toBe(false));
    expect(client.file).not.toHaveBeenCalled();
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

  describe('the filters « Tout / Non lus » and the unread counts', () => {
    /** Sujet 1 unread and Sujet 2 read in École, Sujet 3 read in Perso, Sujet 4 unread and Sujet 5 read in the inbox. */
    function zones() {
      const [m1, m2, m3, m4, m5] = fiveMails();
      const set = (m: MailSummary | undefined, labels: string[]) => ({
        ...m!,
        labels,
        unread: labels.includes('UNREAD'),
      });
      return fakeClient({
        mails: [
          set(m1, ['L-ecole', 'UNREAD']),
          set(m2, ['L-ecole']),
          set(m3, ['L-perso']),
          set(m4, ['INBOX', 'UNREAD']),
          set(m5, ['INBOX']),
        ],
      });
    }

    const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
    const rail = (name: string) => screen.getByRole('link', { name: new RegExp(`^${name}`) });
    const chip = (name: string) =>
      within(screen.getByRole('group', { name: 'Zones', hidden: true })).getByRole('button', {
        name: new RegExp(`^${name}`),
        hidden: true,
      });

    async function show(fake = zones(), onchange?: () => void) {
      const user = userEvent.setup();
      render(Mailbox, { props: { client: fake.client, onchange } });
      render(Toaster);
      const list = await screen.findByRole('group', { name: 'Mails' });
      await within(list).findByText('Sujet 4');
      return { ...fake, user, list };
    }

    it('offers « Tout » and « Non lus », and no « Proposés »', async () => {
      await show();
      expect(tab('Tout')).toHaveAttribute('aria-selected', 'true');
      expect(tab('Non lus')).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /Proposés/ })).toBeNull();
    });

    it('« Non lus » asks the server, which finds an unread mail past the loaded ones, and pages on its cursor', async () => {
      const fake = zones();
      const all = fake.client.listMail.getMockImplementation()!;
      // « Tout » shows only Sujet 5 on its first page; the server's unread filter finds Sujet 4.
      fake.client.listMail.mockImplementation(async (view, o = {}) => {
        const page = await all(view, o);
        if (o.unread) return o.cursor ? { items: [] } : { ...page, cursor: 'u1' };
        return { items: page.items.filter((m) => m.id !== 'm4'), cursor: 'suite' };
      });
      const user = userEvent.setup();
      render(Mailbox, { props: { client: fake.client } });
      const list = await screen.findByRole('group', { name: 'Mails' });
      await within(list).findByText('Sujet 5');
      expect(within(list).queryByText('Sujet 4')).toBeNull();
      await user.click(tab('Non lus'));
      expect(await within(list).findByText('Sujet 4')).toBeInTheDocument();
      expect(within(list).queryByText('Sujet 5')).toBeNull();
      expect(fake.client.listMail).toHaveBeenLastCalledWith('inbox', { unread: true });
      await user.click(screen.getByRole('button', { name: 'Mails plus anciens' }));
      expect(fake.client.listMail).toHaveBeenLastCalledWith('inbox', { cursor: 'u1', unread: true });
    });

    it('does not page « Non lus » on the cursor of « Tout » while the filtered list still loads', async () => {
      const fake = zones();
      const all = fake.client.listMail.getMockImplementation()!;
      let answer = () => {};
      fake.client.listMail.mockImplementation(async (view, o = {}) => {
        const page = await all(view, o);
        if (!o.unread) return { ...page, cursor: 'suite' };
        await new Promise<void>((r) => (answer = r));
        return page;
      });
      const user = userEvent.setup();
      render(Mailbox, { props: { client: fake.client } });
      const list = await screen.findByRole('group', { name: 'Mails' });
      await within(list).findByText('Sujet 5');
      await user.click(tab('Non lus'));
      await user.click(screen.getByRole('button', { name: 'Mails plus anciens' }));
      expect(fake.client.listMail).not.toHaveBeenCalledWith('inbox', { cursor: 'suite', unread: true });
      answer();
    });

    it('puts each zone’s unread count on its rail link, its chip and the « Non lus » tab, never a zero', async () => {
      const { user } = await show();
      await waitFor(() => expect(rail('École')).toHaveTextContent('1'));
      expect(rail('Perso')).not.toHaveTextContent(/\d/);
      expect(chip('Réception')).toHaveTextContent('1');
      expect(chip('École')).toHaveTextContent('1');
      expect(chip('Perso')).not.toHaveTextContent(/\d/);
      expect(screen.queryByRole('button', { name: /^Non lus/, hidden: true })).toBeNull();
      expect(tab('Non lus')).toHaveTextContent('1');
      await user.click(rail('Perso'));
      await waitFor(() => expect(tab('Non lus')).not.toHaveTextContent(/\d/));
      expect(chip('Perso')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Réception')).toHaveAttribute('aria-pressed', 'false');
    });

    it('a folder of Gmail filters on « Non lus » without a count', async () => {
      const { user, client } = await show();
      await user.click(rail('Archives'));
      await waitFor(() => expect(client.listMail).toHaveBeenLastCalledWith('archive', {}));
      expect(tab('Non lus')).not.toHaveTextContent(/\d/);
      await user.click(tab('Non lus'));
      expect(client.listMail).toHaveBeenLastCalledWith('archive', { unread: true });
    });

    it('reads the counts again once an opened unread mail is marked read, and after « Marquer non lu »', async () => {
      const fake = zones();
      const onchange = vi.fn();
      const run = fake.client.markRead.getMockImplementation()!;
      let answer = () => {};
      fake.client.markRead.mockImplementationOnce(
        (id, read) => new Promise((resolve) => (answer = () => resolve(run(id, read)))),
      );
      const { user, list } = await show(fake, onchange);
      await waitFor(() => expect(tab('Non lus')).toHaveTextContent('1'));
      const reads = fake.client.mailCounts.mock.calls.length;
      await user.click(within(list).getByText('Sujet 4'));
      const reader = await screen.findByRole('region', { name: 'Lecture' });
      expect(fake.client.mailCounts).toHaveBeenCalledTimes(reads);
      expect(onchange).not.toHaveBeenCalled();
      answer();
      await waitFor(() => expect(tab('Non lus')).not.toHaveTextContent(/\d/));
      expect(onchange).toHaveBeenCalledOnce();
      await user.click(
        within(within(reader).getByRole('toolbar')).getByRole('button', { name: 'Marquer non lu' }),
      );
      await waitFor(() => expect(tab('Non lus')).toHaveTextContent('1'));
      expect(onchange).toHaveBeenCalledTimes(2);
    });

    it('reads the counts again on a mail event, even while a mail is open', async () => {
      const fake = zones();
      let emit: (e: LunEvent) => void = () => {};
      fake.client.subscribe.mockImplementation((fn) => ((emit = fn), () => {}));
      const { user, list, client } = await show(fake);
      await user.click(within(list).getByText('Sujet 5'));
      await screen.findByRole('region', { name: 'Lecture' });
      const reads = client.mailCounts.mock.calls.length;
      emit({ id: '1', type: 'mail.changed', importance: 'info', at: '', title: '' });
      await waitFor(() => expect(client.mailCounts).toHaveBeenCalledTimes(reads + 1));
    });

    it('changing zone puts « Tout » back', async () => {
      const { user, client } = await show();
      await user.click(tab('Non lus'));
      expect(client.listMail).toHaveBeenLastCalledWith('inbox', { unread: true });
      await user.click(rail('École'));
      await waitFor(() => expect(client.listMail).toHaveBeenLastCalledWith('box:L-ecole', {}));
      expect(tab('Tout')).toHaveAttribute('aria-selected', 'true');
    });

    it('shows no filter during a search, only its line and its cross', async () => {
      const { client } = zones();
      let parts: ScreenParts | null = null;
      render(ShellFixture, { props: { client, onparts: (p: ScreenParts | null) => (parts = p) } });
      await screen.findByRole('tab', { name: /^Non lus/ });
      parts!.search!('facture');
      await waitFor(() => expect(client.listMail).toHaveBeenLastCalledWith('inbox', { q: 'facture' }));
      await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
      expect(screen.getByText('Résultats pour « facture »')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Effacer la recherche' })).toBeInTheDocument();
    });
  });
});
