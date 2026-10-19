<script lang="ts">
  import type { AgendaItem } from '../types.ts';
  import { timeOf } from './dates.ts';

  interface Props {
    item: AgendaItem;
    compact?: boolean;
    onedit: () => void;
    ontoggle: () => void;
  }
  let { item, compact = false, onedit, ontoggle }: Props = $props();
</script>

{#if item.kind === 'event'}
  <button type="button" class="chip event" class:allday={item.allDay} class:compact onclick={onedit}>
    {#if !item.allDay}<span class="time">{timeOf(item.start)}</span>{/if}
    <span class="title">{item.title}</span>
    {#if item.location && !compact}<span class="where">{item.location}</span>{/if}
  </button>
{:else}
  <div class="chip task" class:done={item.done} class:compact>
    <input type="checkbox" aria-label={`Cocher ${item.title}`} checked={item.done} onchange={ontoggle} />
    <button type="button" class="title" onclick={onedit}>{item.title}</button>
  </div>
{/if}

<style>
  .chip {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    box-sizing: border-box;
    margin: 0 0 0.25rem;
    padding: 0.25rem 0.45rem;
    border-radius: 6px;
    font-size: 0.85rem;
    text-align: left;
  }
  .event {
    border: 0;
    border-left: 3px solid var(--monde-accent);
    background: var(--surface-2);
  }
  .event.allday {
    background: var(--accent-doux);
  }
  .task {
    align-items: center;
    border: 1px dashed var(--bordure);
  }
  .task .title {
    border: 0;
    padding: 0;
    text-align: left;
  }
  .done .title {
    text-decoration: line-through;
    color: var(--lune);
  }
  .time,
  .where {
    font-size: 0.75rem;
    color: var(--lune);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .compact {
    font-size: 0.75rem;
    padding: 0.1rem 0.35rem;
    white-space: nowrap;
  }
</style>
