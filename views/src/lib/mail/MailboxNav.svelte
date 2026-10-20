<script lang="ts">
  import type { LabelView } from '../types.ts';

  interface Props {
    view: string;
    boxes: LabelView[];
    pendingCount: number;
    onselect: (view: string) => void;
  }
  let { view, boxes, pendingCount, onselect }: Props = $props();

  const before = [
    { id: 'inbox', name: 'Réception' },
    { id: 'pending', name: 'En attente' },
  ];
  const after = [
    { id: 'archive', name: 'Archives' },
    { id: 'sent', name: 'Envoyés' },
    { id: 'drafts', name: 'Brouillons' },
    { id: 'spam', name: 'Spam' },
    { id: 'trash', name: 'Corbeille' },
  ];
</script>

<nav class="nav" aria-label="Boîtes">
  {#each before as entry (entry.id)}
    <button type="button" class:on={view === entry.id} onclick={() => onselect(entry.id)}>
      {entry.name}
      {#if entry.id === 'pending' && pendingCount > 0}<span class="count">{pendingCount}</span>{/if}
    </button>
  {/each}
  {#if boxes.length}
    <p class="group">Boîtes</p>
    {#each boxes as box (box.id)}
      <button type="button" class:on={view === `box:${box.id}`} onclick={() => onselect(`box:${box.id}`)}
        >{box.name}</button
      >
    {/each}
  {/if}
  <p class="group">Gmail</p>
  {#each after as entry (entry.id)}
    <button type="button" class:on={view === entry.id} onclick={() => onselect(entry.id)}>{entry.name}</button
    >
  {/each}
</nav>

<style>
  .nav {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.75rem 0.5rem;
  }
  .nav button {
    display: flex;
    justify-content: space-between;
    border-color: transparent;
    text-align: left;
  }
  .nav button.on {
    background: var(--accent-doux);
  }
  .count {
    min-width: 1.4rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    text-align: center;
    font-size: 0.75rem;
    background: var(--monde-accent);
  }
  .group {
    margin: 0.75rem 0.65rem 0.2rem;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--lavis);
  }
  @media (max-width: 899px) {
    .nav {
      flex-direction: row;
      overflow-x: auto;
      padding: 0.5rem;
    }
    .nav button {
      flex: none;
      gap: 0.4rem;
    }
    .group {
      display: none;
    }
  }
</style>
