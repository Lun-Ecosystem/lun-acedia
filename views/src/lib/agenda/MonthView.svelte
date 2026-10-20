<script lang="ts">
  import type { AgendaItem } from '../types.ts';
  import { dayKey, dayName, itemsOn } from './dates.ts';
  import ItemChip from './ItemChip.svelte';

  interface Props {
    days: Date[];
    month: number;
    items: AgendaItem[];
    today: Date;
    onedit: (item: AgendaItem) => void;
    ontoggle: (item: AgendaItem) => void;
    onday: (day: Date) => void;
  }
  let { days, month, items, today, onedit, ontoggle, onday }: Props = $props();
  const MAX = 3;
  const weekdays = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
</script>

<div class="month">
  {#each weekdays as w (w)}<p class="weekday">{w}</p>{/each}
  {#each days as day (dayKey(day))}
    {@const list = itemsOn(items, day)}
    <section
      class="cell"
      class:other={day.getMonth() !== month}
      class:today={dayKey(day) === dayKey(today)}
      aria-label={dayName(day)}
    >
      <button type="button" class="date" onclick={() => onday(day)}>{day.getDate()}</button>
      {#each list.slice(0, MAX) as item (`${item.kind}:${item.id}`)}
        <ItemChip {item} compact onedit={() => onedit(item)} ontoggle={() => ontoggle(item)} />
      {/each}
      {#if list.length > MAX}
        <button type="button" class="more" onclick={() => onday(day)}>+{list.length - MAX}</button>
      {/if}
    </section>
  {/each}
</div>

<style>
  .month {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 1px;
    background: var(--bordure);
  }
  .weekday {
    margin: 0;
    padding: 0.3rem;
    font-size: 0.75rem;
    text-align: center;
    color: var(--lavis);
    background: var(--monde-fond);
  }
  .cell {
    min-height: 6rem;
    padding: 0.3rem;
    overflow: hidden;
    background: var(--monde-fond);
  }
  .cell.other {
    opacity: 0.45;
  }
  .date {
    border: 0;
    padding: 0 0.3rem;
    font-size: 0.8rem;
  }
  .today .date {
    background: var(--monde-accent);
    border-radius: 999px;
  }
  .more {
    border: 0;
    padding: 0 0.3rem;
    font-size: 0.75rem;
    color: var(--lune);
  }
</style>
