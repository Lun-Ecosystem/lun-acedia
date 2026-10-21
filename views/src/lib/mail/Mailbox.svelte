<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AcediaClient } from '../client.ts';
  import type { BatchOp, LabelView, MailDetail, MailSummary } from '../types.ts';
  import Composer from './Composer.svelte';
  import { errorText } from './format.ts';
  import MailboxNav from './MailboxNav.svelte';
  import MailList from './MailList.svelte';
  import MailReader from './MailReader.svelte';

  let { client }: { client: AcediaClient } = $props();

  let view = $state('inbox');
  let query = $state('');
  let items = $state<MailSummary[]>([]);
  let cursor = $state<string | undefined>();
  let labels = $state<LabelView[]>([]);
  let pendingCount = $state(0);
  let openId = $state<string | null>(null);
  let detail = $state<MailDetail | null>(null);
  let composing = $state<{ replyTo?: MailDetail } | null>(null);
  let error = $state<string | null>(null);
  const selected = new SvelteSet<string>();

  const boxes = $derived(labels.filter((l) => l.role === 'box'));
  const open = $derived(items.find((m) => m.id === openId));
  const searching = $derived(query.trim() !== '');

  const fail = (err: unknown) => (error = errorText(err));

  async function load(more = false) {
    try {
      const page = await client.listMail(view, {
        ...(searching ? { q: query.trim() } : {}),
        ...(more && cursor ? { cursor } : {}),
      });
      items = more ? [...items, ...page.items] : page.items;
      cursor = page.cursor;
    } catch (err) {
      fail(err);
    }
  }

  async function refreshPending() {
    try {
      pendingCount = (await client.listMail('pending')).items.length;
    } catch {
      // The count is a hint; the list itself reports its errors.
    }
  }

  onMount(() => {
    client
      .listLabels()
      .then((l) => (labels = l))
      .catch(fail);
    void load();
    void refreshPending();
    return client.subscribe((e) => {
      if (!e.type.startsWith('mail.')) return;
      void refreshPending();
      // Never reshuffle the list under a mail being read.
      if (openId === null) void load();
    });
  });

  function select(next: string) {
    view = next;
    query = '';
    close();
    selected.clear();
    void load();
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    close();
    selected.clear();
    void load();
  }

  function close() {
    openId = null;
    detail = null;
  }

  async function openMail(m: MailSummary) {
    composing = null;
    openId = m.id;
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

  /**
   * Removes the mails from the list at once and goes back to it; puts them back and says so if the
   * server refuses.
   */
  async function act(ids: string[], run: () => Promise<unknown>) {
    error = null;
    const before = items;
    items = items.filter((m) => !ids.includes(m.id));
    for (const id of ids) selected.delete(id);
    if (openId && ids.includes(openId)) close();
    try {
      await run();
      void refreshPending();
    } catch (err) {
      items = before;
      fail(err);
    }
  }

  /** Filing into the box being viewed keeps the mail in the list. */
  function file(ids: string[], boxId: string) {
    if (view === `box:${boxId}`) return act([], () => client.batch(ids, { kind: 'file', boxId }));
    return ids.length === 1
      ? act(ids, () => client.file(ids[0]!, boxId))
      : batch(ids, { kind: 'file', boxId });
  }

  const batch = (ids: string[], op: BatchOp) => act(ids, () => client.batch(ids, op));

  async function markUnread(m: MailSummary) {
    close();
    items = items.map((x) => (x.id === m.id ? { ...x, unread: true } : x));
    client.markRead(m.id, false).catch(fail);
  }
</script>

<div class="mailbox lun-acedia" data-monde="acedia" class:reading={openId !== null || composing !== null}>
  <aside class="side">
    <button type="button" class="compose" onclick={() => ((composing = {}), close())}>Nouveau message</button>
    <MailboxNav {view} {boxes} {pendingCount} onselect={select} />
  </aside>

  <div class="listing">
    <form class="search" role="search" onsubmit={search}>
      <input
        type="search"
        placeholder="Rechercher (syntaxe Gmail)"
        aria-label="Rechercher"
        bind:value={query}
      />
    </form>
    {#if error}
      <p class="error" role="alert">
        {error}
        <button type="button" aria-label="Fermer le message" onclick={() => (error = null)}>×</button>
      </p>
    {/if}
    <MailList
      {items}
      {labels}
      {selected}
      {openId}
      hasMore={cursor !== undefined}
      onopen={openMail}
      onvalidate={(m) => act([m.id], () => client.validate(m.id))}
      oncorrect={(m, boxId) => act([m.id], () => client.correct(m.id, boxId, m.proposal?.tagIds ?? []))}
      onfileselected={(boxId) => file([...selected], boxId)}
      onarchiveselected={() => batch([...selected], { kind: 'archive' })}
      ontrashselected={() => batch([...selected], { kind: 'trash' })}
      onmore={() => load(true)}
    />
  </div>

  <div class="pane">
    {#if composing}
      {#key composing}
        <Composer
          {client}
          replyTo={composing.replyTo}
          onclose={() => (composing = null)}
          onsent={() => (composing = null)}
        />
      {/key}
    {:else if open}
      <MailReader
        {client}
        mail={open}
        {detail}
        {labels}
        onback={close}
        onfile={(boxId) => file([open.id], boxId)}
        onvalidate={() => act([open.id], () => client.validate(open.id))}
        onarchive={() => act([open.id], () => client.archive(open.id))}
        ontrash={() => act([open.id], () => client.trash(open.id))}
        onspam={() => act([open.id], () => client.spam(open.id))}
        onunread={() => markUnread(open)}
        onreply={() => detail && (composing = { replyTo: detail })}
        onerror={fail}
      />
    {:else}
      <p class="placeholder">Choisir un mail à lire.</p>
    {/if}
  </div>
</div>

<style>
  .mailbox {
    display: grid;
    grid-template-columns: 13rem minmax(22rem, 2fr) 3fr;
    height: 100%;
    min-height: 0;
  }
  .side {
    border-right: 1px solid var(--bordure);
    overflow-y: auto;
  }
  .compose {
    margin: 0.75rem 0.5rem 0;
    width: calc(100% - 1rem);
    border-color: var(--monde-accent);
  }
  .listing {
    overflow-y: auto;
    border-right: 1px solid var(--bordure);
  }
  .search {
    padding: 0.6rem 0.75rem;
  }
  .search input {
    width: 100%;
    box-sizing: border-box;
  }
  .pane {
    min-height: 0;
    overflow: hidden;
  }
  .placeholder {
    padding: 2rem;
    color: var(--lune);
  }
  .error {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 0 0.75rem 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--rayon);
    background: rgba(122, 24, 24, 0.35);
  }
  /* Under 900 px: one column; the reader takes the whole screen with its back button. */
  @media (max-width: 899px) {
    .mailbox {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr;
    }
    .side {
      border-right: 0;
      border-bottom: 1px solid var(--bordure);
    }
    .pane {
      display: none;
    }
    .reading .side,
    .reading .listing {
      display: none;
    }
    .reading .pane {
      display: block;
      grid-row: 1 / -1;
    }
  }
</style>
