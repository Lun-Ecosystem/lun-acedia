<script lang="ts">
  import { ChevronLeft, ChevronRight } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import { dayKey, dayName, visibleDays } from './dates.ts';

  /** The small month of the rail (plate 5): the shown period lit, today in the accent. */

  interface Props {
    cursor: Date;
    now: Date;
    /** Days shown by the agenda. */
    shown: Date[];
    onpick: (day: Date) => void;
  }
  let { cursor, now, shown, onpick }: Props = $props();

  // Follows the agenda, and can be leafed through on its own.
  let month = $derived(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const days = $derived(visibleDays('month', month));
  const lit = $derived(new Set(shown.length < 28 ? shown.map(dayKey) : []));
  const today = $derived(dayKey(now));
  const leaf = (n: number) => (month = new Date(month.getFullYear(), month.getMonth() + n, 1));
</script>

<div class="mini">
  <div class="t">
    <span>{month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</span>
    <span class="fleches">
      <IconButton icon={ChevronLeft} label="Mois précédent" size="petit" onclick={() => leaf(-1)} />
      <IconButton icon={ChevronRight} label="Mois suivant" size="petit" onclick={() => leaf(1)} />
    </span>
  </div>
  <div class="g">
    {#each ['L', 'M', 'M', 'J', 'V', 'S', 'D'] as d, i (i)}<b aria-hidden="true">{d}</b>{/each}
    {#each days as day (dayKey(day))}
      <button
        type="button"
        class={{
          h: day.getMonth() !== month.getMonth(),
          cs: lit.has(dayKey(day)),
          auj: dayKey(day) === today,
        }}
        aria-label={dayName(day)}
        aria-current={dayKey(day) === today ? 'date' : undefined}
        onclick={() => onpick(day)}>{day.getDate()}</button
      >
    {/each}
  </div>
</div>

<style>
  .mini {
    padding: 0 0 4px;
  }
  .t {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 4px 6px;
    font-size: 13px;
  }
  .fleches {
    display: flex;
    color: var(--texte-3);
  }
  .g {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    row-gap: 2px;
    text-align: center;
    font-size: 11.5px;
  }
  b {
    padding-bottom: 2px;
    font-weight: 400;
    font-size: 10.5px;
    color: var(--texte-3);
  }
  .g button {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    margin: auto;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--texte-2);
    font: 400 11.5px var(--sans);
    cursor: pointer;
  }
  .g button:hover {
    background: var(--survol);
    color: var(--texte);
  }
  .g button.h {
    color: var(--texte-3);
    opacity: 0.6;
  }
  .g button.cs {
    background: var(--survol);
    color: var(--texte);
  }
  .g button.auj {
    background: var(--accent);
    color: var(--texte);
    opacity: 1;
  }
</style>
