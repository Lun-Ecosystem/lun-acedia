<script lang="ts">
  import type { AgendaItem } from '../types.ts';
  import { dayKey, dayName, itemsOn } from './dates.ts';
  import ItemChip from './ItemChip.svelte';

  interface Props {
    days: Date[];
    items: AgendaItem[];
    today: Date;
    onedit: (item: AgendaItem) => void;
    ontoggle: (item: AgendaItem) => void;
  }
  let { days, items, today, onedit, ontoggle }: Props = $props();
</script>

<div class="week" style:--columns={days.length}>
  {#each days as day (dayKey(day))}
    <section class="day" class:today={dayKey(day) === dayKey(today)} aria-label={dayName(day)}>
      <h3>{dayName(day)}</h3>
      {#each itemsOn(items, day) as item (`${item.kind}:${item.id}`)}
        <ItemChip {item} onedit={() => onedit(item)} ontoggle={() => ontoggle(item)} />
      {:else}
        <p class="empty">Rien</p>
      {/each}
    </section>
  {/each}
</div>

<style>
  .week {
    display: grid;
    grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
    gap: 1px;
    background: var(--bordure);
    min-height: 100%;
  }
  .day {
    padding: 0.5rem;
    background: var(--monde-fond);
  }
  .day.today h3 {
    color: var(--ivoire);
    border-bottom-color: var(--monde-accent);
  }
  h3 {
    margin: 0 0 0.5rem;
    padding-bottom: 0.3rem;
    border-bottom: 2px solid transparent;
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1rem;
    color: var(--lune);
    text-transform: capitalize;
  }
  .empty {
    margin: 0;
    font-size: 0.75rem;
    color: var(--lune);
    opacity: 0.5;
  }
  @media (max-width: 899px) {
    .week {
      grid-template-columns: 1fr;
    }
  }
</style>
