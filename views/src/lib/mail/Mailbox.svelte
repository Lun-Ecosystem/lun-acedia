<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AcediaClient } from '../client.ts';
  import type { BatchOp, LabelView, MailDetail, MailSummary } from '../types.ts';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import Chip from '../ui/Chip.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import Field from '../ui/Field.svelte';
  import { Clock, Plus, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import { setScreenContext, shellOf } from '../ui/shell.ts';
  import { bindShortcuts } from '../ui/shortcuts.ts';
  import Tabs from '../ui/Tabs.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import { toast } from '../ui/toasts.svelte.ts';
  import BoxMenu from './BoxMenu.svelte';
  import Composer from './Composer.svelte';
  import { errorText, targetName } from './format.ts';
  import MailboxNav from './MailboxNav.svelte';
  import MailList from './MailList.svelte';
  import MailReader from './MailReader.svelte';
  import SelectionBar from './SelectionBar.svelte';

  /*
   * The mail screen (plate 03). Without an open mail the list takes the whole width; the reading pane
   * exists only while a mail is open (a second screen on a phone). Inside an app shell, its main action
   * and its boxes go into the shell's rail; alone, it shows them in a column of its own.
   */

  interface Props {
    client: AcediaClient;
    /** View shown first: `inbox`, `pending`, `box:<id>`, `archive`… */
    start?: string | undefined;
    /** Something changed in the mails (an action, an undo): counters around can refresh. */
    onchange?: (() => void) | undefined;
    /** Mail opened once the first view is loaded (coming from « À valider »). */
    opening?: string | undefined;
    /** Draft opened in the composer (« Ouvrir le brouillon » of Pina); a new object opens it again. */
    draft?: { id: string } | undefined;
    /** Opens the Journal (from the empty inbox). */
    onjournal?: (() => void) | undefined;
  }
  let { client, start = 'inbox', onchange, opening, draft, onjournal }: Props = $props();

  // svelte-ignore state_referenced_locally
  let view = $state(start);
  let query = $state('');
  let items = $state<MailSummary[]>([]);
  let cursor = $state<string | undefined>();
  let labels = $state<LabelView[]>([]);
  let loading = $state(true);
  let threshold = $state(100);
  let openId = $state<string | null>(null);
  let detail = $state<MailDetail | null>(null);
  let composing = $state<{ replyTo?: MailDetail; forward?: MailDetail; draftId?: string } | null>(null);
  let error = $state<string | null>(null);
  let filter = $state('tout');
  /** Mails the sort filed today, said by the empty inbox; `null` while unknown. */
  let filedToday = $state<number | null>(null);
  /** Mail of the keyboard (J, K), when none is open. */
  let current = $state<string | null>(null);
  const selected = new SvelteSet<string>();

  let menu = $state<{ open: boolean; anchor: HTMLElement | null; ids: string[] }>({
    open: false,
    anchor: null,
    ids: [],
  });
  let creating = $state<{ open: boolean; name: string; ids: string[]; error?: string }>({
    open: false,
    name: '',
    ids: [],
  });

  const boxes = $derived(labels.filter((l) => l.role === 'box'));
  const searching = $derived(query.trim() !== '');
  const shown = $derived(
    filter === 'nonlus'
      ? items.filter((m) => m.unread)
      : filter === 'proposes'
        ? items.filter((m) => m.proposal?.status === 'pending')
        : items,
  );
  const open = $derived(items.find((m) => m.id === openId));
  const narrow = $derived(openId !== null || composing !== null);
  const menuMails = $derived(items.filter((m) => menu.ids.includes(m.id)));
  /** The AI's box for the mail of the menu, on top of it. */
  const suggested = $derived(
    menuMails.length === 1 && menuMails[0]!.proposal?.status === 'pending'
      ? menuMails[0]!.proposal.boxId
      : null,
  );
  const position = $derived.by(() => {
    const index = shown.findIndex((m) => m.id === openId);
    return index < 0 ? '' : `${index + 1} sur ${shown.length}`;
  });

  const fail = (err: unknown) => (error = errorText(err));

  /** Only the last load asked shows: an older answer arriving late is dropped. */
  let loads = 0;

  async function load(more = false) {
    const seq = ++loads;
    loading = true;
    try {
      const page = await client.listMail(view, {
        ...(searching ? { q: query.trim() } : {}),
        ...(more && cursor ? { cursor } : {}),
      });
      if (seq !== loads) return;
      items = more ? [...items, ...page.items] : page.items;
      cursor = page.cursor;
      if (view === 'inbox' && !searching && items.length === 0)
        client
          .todayStats()
          .then((s) => (filedToday = s.autoFiled))
          .catch(() => (filedToday = null));
    } catch (err) {
      fail(err);
    } finally {
      if (seq === loads) loading = false;
    }
  }

  onMount(() => {
    client
      .listLabels()
      .then((l) => (labels = l))
      .catch(fail);
    client
      .getSettings()
      .then((s) => (threshold = s.threshold))
      .catch(() => {
        // Without it, the proposal card simply says nothing of the threshold.
      });
    void load().then(() => {
      const m = items.find((x) => x.id === opening);
      if (m) void openMail(m);
    });
    return client.subscribe((e) => {
      // Never reshuffle the list under a mail being read.
      if (e.type.startsWith('mail.') && openId === null) void load();
    });
  });

  function select(next: string) {
    view = next;
    query = '';
    filter = 'tout';
    close();
    selected.clear();
    void load();
  }

  function search(q: string) {
    query = q;
    filter = 'tout';
    close();
    selected.clear();
    void load();
  }

  // A command from outside (Pina), not a value to mirror: each new object opens the composer on it.
  $effect(() => {
    if (!draft) return;
    const id = draft.id;
    untrack(() => {
      close();
      composing = { draftId: id };
    });
  });

  function compose() {
    close();
    composing = {};
  }

  function close() {
    openId = null;
    detail = null;
  }

  async function openMail(m: MailSummary) {
    composing = null;
    openId = m.id;
    current = m.id;
    detail = null;
    try {
      const d = await client.getMail(m.id);
      if (openId === m.id) detail = d;
    } catch (err) {
      fail(err);
    }
    if (m.unread) {
      // Marked read in place: the row keeps its position.
      items = items.map((x) => (x.id === m.id ? { ...x, unread: false } : x));
      client.markRead(m.id, true).catch(fail);
    }
  }

  type Journaled = { journalId?: number | undefined };

  /**
   * Removes the mails from the list at once and goes back to it, then offers to undo (6 s, or Z). Puts
   * them back and says so if the server refuses.
   */
  async function act(
    ids: string[],
    run: () => Promise<Journaled | Journaled[]>,
    message: string,
    keep = false,
  ) {
    error = null;
    const before = items;
    if (!keep) items = items.filter((m) => !ids.includes(m.id));
    for (const id of ids) selected.delete(id);
    if (openId && ids.includes(openId)) close();
    try {
      const journal = [await run()].flat().flatMap((r) => (r.journalId === undefined ? [] : [r.journalId]));
      onchange?.();
      toast(
        message,
        journal.length
          ? {
              undo: async () => {
                // One undo refused must not leave the list showing half the batch.
                try {
                  for (const id of journal) await client.undo(id);
                } finally {
                  await load();
                  onchange?.();
                }
              },
            }
          : {},
      );
    } catch (err) {
      items = before;
      fail(err);
    }
  }

  const many = (n: number, one: string, more: string) => (n > 1 ? `${n} mails ${more}` : one);

  /** Files the mails; for a mail that waits on a proposal, it validates or corrects it. */
  function file(ids: string[], boxId: string) {
    const name = targetName(boxId, labels);
    const message =
      boxId === 'trash'
        ? 'Mis à la corbeille'
        : many(ids.length, `Rangé dans ${name}`, `rangés dans ${name}`);
    const keep = view === `box:${boxId}`;
    const mail = ids.length === 1 ? items.find((m) => m.id === ids[0]) : undefined;
    const pending = mail?.proposal?.status === 'pending' ? mail.proposal : undefined;
    if (mail && pending)
      return act(
        ids,
        () =>
          boxId === pending.boxId ? client.validate(mail.id) : client.correct(mail.id, boxId, pending.tagIds),
        message,
        keep,
      );
    if (mail) return act(ids, () => client.file(mail.id, boxId), message, keep);
    return batch(ids, { kind: 'file', boxId }, message, keep);
  }

  const batch = (ids: string[], op: BatchOp, message: string, keep = false) =>
    act(ids, () => client.batch(ids, op), message, keep);

  function validate(m: MailSummary) {
    const boxId = m.proposal?.boxId ?? null;
    return act([m.id], () => client.validate(m.id), `Rangé dans ${targetName(boxId, labels)}`);
  }
  const archive = (ids: string[]) =>
    ids.length === 1
      ? act(ids, () => client.archive(ids[0]!), 'Archivé')
      : batch(ids, { kind: 'archive' }, many(ids.length, 'Archivé', 'archivés'));
  const trash = (ids: string[]) =>
    ids.length === 1
      ? act(ids, () => client.trash(ids[0]!), 'Mis à la corbeille')
      : batch(ids, { kind: 'trash' }, many(ids.length, 'Mis à la corbeille', 'mis à la corbeille'));
  const spam = (id: string) => act([id], () => client.spam(id), 'Signalé comme spam');

  function markRead(ids: string[]) {
    items = items.map((m) => (ids.includes(m.id) ? { ...m, unread: false } : m));
    selected.clear();
    client
      .batch(ids, { kind: 'read', read: true })
      .then(() => onchange?.())
      .catch(fail);
  }

  function markUnread(m: MailSummary) {
    close();
    items = items.map((x) => (x.id === m.id ? { ...x, unread: true } : x));
    client
      .markRead(m.id, false)
      .then(() => onchange?.())
      .catch(fail);
  }

  function openMenu(ids: string[], anchor: HTMLElement | null) {
    menu = { open: true, anchor, ids };
  }

  function createBox(ids: string[]) {
    menu.open = false;
    creating = { open: true, name: '', ids };
  }

  async function saveBox(event: SubmitEvent) {
    event.preventDefault();
    const name = creating.name.trim();
    if (!name) return;
    try {
      const box = await client.createLabel(name, 'box');
      labels = [...labels, box];
      const ids = creating.ids;
      creating.open = false;
      if (ids.length) void file(ids, box.id);
    } catch (err) {
      creating.error = errorText(err);
    }
  }

  // ---- Keyboard: J, K, Enter (on the row), Escape, V, C, R, E, #, X. Never from a menu or a window.
  const target = () => items.find((m) => m.id === (openId ?? current));
  const rowOf = (id: string) => document.getElementById(`mail-${id}`);

  function move(step: number) {
    if (!shown.length) return;
    const index = shown.findIndex((m) => m.id === (openId ?? current));
    const next = shown[Math.min(shown.length - 1, Math.max(0, index < 0 ? 0 : index + step))]!;
    current = next.id;
    if (openId) void openMail(next);
    rowOf(next.id)?.focus();
  }

  /** A menu or a window has the keyboard: the screen's shortcuts wait. */
  const overlay = () => Boolean(document.activeElement?.closest('[role="menu"], [role="dialog"]'));

  $effect(() => {
    const when = (run: () => void) => () => {
      if (!overlay() && !composing) run();
    };
    const on = (run: (m: MailSummary) => void) =>
      when(() => {
        const m = target();
        if (m) run(m);
      });
    return bindShortcuts({
      j: when(() => move(1)),
      k: when(() => move(-1)),
      Escape: () => {
        if (overlay()) return;
        if (composing) composing = null;
        else if (openId) close();
        else selected.clear();
      },
      v: on((m) => m.proposal?.status === 'pending' && validate(m)),
      // Row scrolled out of the list (or reader alone): anchor on the reader's « Ranger dans », else the tabs.
      c: on((m) =>
        openMenu(
          [m.id],
          rowOf(m.id) ??
            document.querySelector<HTMLElement>(
              '[aria-label="Lecture"] [role="toolbar"] [aria-haspopup="menu"]',
            ) ??
            document.querySelector<HTMLElement>('.onglets'),
        ),
      ),
      r: when(() => detail && (composing = { replyTo: detail })),
      e: on((m) => archive([m.id])),
      '#': on((m) => trash([m.id])),
      x: on((m) => (selected.has(m.id) ? selected.delete(m.id) : selected.add(m.id))),
    });
  });

  // ---- The shell around, if any, gets the main action and the boxes.
  const shell = shellOf();
  // What Pina sees: the mail open (« ce mail »), or the composer.
  setScreenContext({
    get screen() {
      return composing ? ('compose' as const) : ('mail' as const);
    },
    get mailId() {
      return openId ?? undefined;
    },
    get draftId() {
      return composing?.draftId;
    },
    get label() {
      return detail?.subject;
    },
  });
  $effect(() => {
    if (!shell) return;
    shell({
      action: newMessage,
      rail: nav,
      compose,
      search,
      get home() {
        return view === 'inbox' && !searching;
      },
      goHome: () => select('inbox'),
    });
    return () => shell(null);
  });

  const emptyText = $derived(
    searching
      ? `Aucun résultat pour « ${query.trim()} »`
      : filter === 'tout'
        ? view === 'inbox'
          ? 'La réception est vide'
          : 'Aucun mail ici'
        : 'Aucun mail de ce filtre',
  );
  // An empty inbox says where the mails went: the sort files them in their boxes.
  const emptyMessage = $derived(
    view !== 'inbox' || searching || filter !== 'tout'
      ? undefined
      : filedToday
        ? `Le tri a rangé ${filedToday} ${filedToday > 1 ? 'mails aujourd’hui dans leurs boîtes' : 'mail aujourd’hui dans sa boîte'}.`
        : 'Les mails rangés par le tri sont dans leurs boîtes, le journal les retrace.',
  );
</script>

{#snippet journalLink()}
  <Button variant="fantome" size="petit" icon={Clock} onclick={onjournal}>Voir le journal</Button>
{/snippet}

{#snippet newMessage()}
  <Button variant="principal" icon={Plus} class="nouveau" onclick={compose}>Nouveau message</Button>
{/snippet}

{#snippet nav()}
  <MailboxNav {view} {boxes} onselect={select} oncreate={() => createBox([])} />
{/snippet}

<div class={['mailbox', 'lun-acedia', { seul: !shell }]} data-monde="acedia">
  {#if !shell}
    <aside class="cote">
      {@render newMessage()}
      {@render nav()}
    </aside>
  {/if}

  <div class={['liste', { etroite: narrow }]}>
    <div class="pastilles" role="group" aria-label="Filtres">
      <Chip on={view === 'inbox' && filter === 'tout' && !searching} onclick={() => select('inbox')}
        >Réception</Chip
      >
      <Chip on={filter === 'nonlus'} onclick={() => (filter = filter === 'nonlus' ? 'tout' : 'nonlus')}
        >Non lus</Chip
      >
      {#each boxes as box (box.id)}
        <Chip on={view === `box:${box.id}`} onclick={() => select(`box:${box.id}`)}>{box.name}</Chip>
      {/each}
    </div>
    {#if selected.size > 0}
      <SelectionBar
        count={selected.size}
        onclear={() => selected.clear()}
        onfile={(anchor) => openMenu([...selected], anchor)}
        onarchive={() => archive([...selected])}
        onread={() => markRead([...selected])}
        ontrash={() => trash([...selected])}
      />
    {:else}
      <div class="onglets">
        <Tabs
          label="Filtrer les mails"
          bind:value={filter}
          items={[
            { value: 'tout', label: 'Tout' },
            { value: 'nonlus', label: 'Non lus', count: items.filter((m) => m.unread).length },
            {
              value: 'proposes',
              label: 'Proposés',
              count: items.filter((m) => m.proposal?.status === 'pending').length,
            },
          ]}
        >
          {#snippet tools()}
            {#if searching}
              <span class="recherche">Résultats pour « {query.trim()} »</span>
              <IconButton icon={X} label="Effacer la recherche" size="petit" onclick={() => search('')} />
            {/if}
          {/snippet}
        </Tabs>
      </div>
    {/if}
    {#if error}
      <Banner title={error} class="erreur">
        {#snippet action()}
          <IconButton icon={X} label="Fermer le message" size="petit" onclick={() => (error = null)} />
        {/snippet}
      </Banner>
    {/if}
    <div class="defile">
      <MailList
        items={shown}
        {labels}
        {selected}
        {openId}
        focusId={shown.some((m) => m.id === (openId ?? current)) ? (openId ?? current) : null}
        {loading}
        compact={narrow}
        empty={emptyText}
        {emptyMessage}
        emptyAction={emptyMessage && onjournal ? journalLink : undefined}
        hasMore={cursor !== undefined}
        onopen={openMail}
        onvalidate={validate}
        onfile={(m, anchor) => openMenu([m.id], anchor)}
        onarchive={(m) => archive([m.id])}
        ontrash={(m) => trash([m.id])}
        onmore={() => load(true)}
        onmove={move}
        onfocus={(m) => (current = m.id)}
      />
    </div>
  </div>

  {#if composing}
    {#key composing}
      <Composer
        {client}
        replyTo={composing.replyTo}
        forward={composing.forward}
        draftId={composing.draftId}
        onclose={() => (composing = null)}
        onsent={() => {
          composing = null;
          toast('Message envoyé');
        }}
      />
    {/key}
  {:else if open}
    <MailReader
      {client}
      mail={open}
      {detail}
      {labels}
      {threshold}
      {position}
      onback={close}
      onfile={(anchor) => openMenu([open.id], anchor)}
      onvalidate={() => validate(open)}
      onarchive={() => archive([open.id])}
      ontrash={() => trash([open.id])}
      onspam={() => spam(open.id)}
      onunread={() => markUnread(open)}
      onreply={() => detail && (composing = { replyTo: detail })}
      onforward={() => detail && (composing = { forward: detail })}
      onerror={(message) => (error = message)}
    />
  {/if}
</div>

<BoxMenu
  bind:open={menu.open}
  anchor={menu.anchor}
  {boxes}
  {suggested}
  withTrash={menuMails.some((m) => m.proposal?.status === 'pending')}
  onpick={(boxId) => file(menu.ids, boxId)}
  oncreate={() => createBox(menu.ids)}
/>

<Dialog
  title="Nouvelle boîte"
  description="Elle devient un libellé Gmail."
  bind:open={creating.open}
  width={400}
>
  <form id="nouvelle-boite" onsubmit={saveBox}>
    <Field label="Nom de la boîte" error={creating.error}>
      <TextInput bind:value={creating.name} placeholder="Factures" required />
    </Field>
  </form>
  {#snippet footer({ close: cancel })}
    <Button variant="fantome" onclick={cancel}>Annuler</Button>
    <Button type="submit" variant="principal" form="nouvelle-boite" disabled={!creating.name.trim()}
      >Créer</Button
    >
  {/snippet}
</Dialog>

<style>
  .mailbox {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .cote {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 2px;
    width: 232px;
    padding: 14px 10px;
    box-sizing: border-box;
    overflow-y: auto;
    border-right: 1px solid var(--bordure);
  }
  :global(.nouveau) {
    width: 100%;
    height: 38px;
  }
  .liste {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .liste.etroite {
    flex: 0 0 430px;
    border-right: 1px solid var(--bordure);
  }
  .onglets {
    padding: 0 18px;
  }
  .etroite .onglets {
    padding: 0 10px;
  }
  .recherche {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pastilles {
    display: none;
  }
  .liste :global(.erreur) {
    margin: 10px 14px 0;
  }
  .defile {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* Phone: the list alone, filters in chips that scroll; the reading is a screen of its own. */
  @media (max-width: 767.98px) {
    .cote {
      display: none;
    }
    .liste,
    .liste.etroite {
      flex: 1 1 auto;
      border-right: 0;
    }
    .onglets {
      display: none;
    }
    .pastilles {
      display: flex;
      gap: 6px;
      padding: 0 14px 8px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    /* Room for the floating button and the bottom bar of the shell. */
    .defile {
      padding-bottom: 72px;
    }
  }
</style>
