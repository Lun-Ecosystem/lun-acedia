<script lang="ts">
  import type { SvelteSet } from 'svelte/reactivity';
  import type { LabelView, MailSummary } from '../types.ts';
  import BoxMenu from './BoxMenu.svelte';
  import MailRow from './MailRow.svelte';

  interface Props {
    items: MailSummary[];
    labels: LabelView[];
    selected: SvelteSet<string>;
    openId: string | null;
    hasMore: boolean;
    onopen: (m: MailSummary) => void;
    onvalidate: (m: MailSummary) => void;
    oncorrect: (m: MailSummary, boxId: string) => void;
    onfileselected: (boxId: string) => void;
    onarchiveselected: () => void;
    ontrashselected: () => void;
    onmore: () => void;
  }
  let {
    items,
    labels,
    selected,
    openId,
    hasMore,
    onopen,
    onvalidate,
    oncorrect,
    onfileselected,
    onarchiveselected,
    ontrashselected,
    onmore,
  }: Props = $props();

  const boxes = $derived(labels.filter((l) => l.role === 'box'));

  function toggle(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }

  /** Selects every listed mail from the senders already selected. */
  function sameSenders() {
    const senders = new Set(items.filter((m) => selected.has(m.id)).map((m) => m.from.addr.toLowerCase()));
    for (const m of items) if (senders.has(m.from.addr.toLowerCase())) selected.add(m.id);
  }
</script>

{#if selected.size > 0}
  <div class="batch" role="toolbar" aria-label="Actions groupées">
    <span>{selected.size} sélectionné{selected.size > 1 ? 's' : ''}</span>
    <BoxMenu label="Ranger" {boxes} onpick={onfileselected} />
    <button type="button" onclick={onarchiveselected}>Archiver</button>
    <button type="button" onclick={ontrashselected}>Corbeille</button>
    <button type="button" onclick={sameSenders}>Tout cet expéditeur</button>
    <button type="button" onclick={() => selected.clear()}>Désélectionner</button>
  </div>
{/if}

{#if items.length === 0}
  <p class="empty">Aucun mail ici.</p>
{/if}
<ul class="list" aria-label="Mails">
  {#each items as mail (mail.id)}
    <MailRow
      {mail}
      {labels}
      checked={selected.has(mail.id)}
      active={mail.id === openId}
      onopen={() => onopen(mail)}
      ontoggle={() => toggle(mail.id)}
      onvalidate={() => onvalidate(mail)}
      oncorrect={(boxId) => oncorrect(mail, boxId)}
    />
  {/each}
</ul>
{#if hasMore}
  <button type="button" class="more" onclick={onmore}>Mails plus anciens</button>
{/if}

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .batch {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--monde-accent);
  }
  .empty {
    padding: 1.5rem 0.75rem;
    color: var(--lune);
  }
  .more {
    margin: 0.75rem;
  }
</style>
