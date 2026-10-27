<script lang="ts">
  import type { AgendaEvent, AgendaItem, AgendaTask } from '../types.ts';
  import { dayKey, dayName, itemKey, itemsOn, timeOf } from './dates.ts';
  import TaskCheck from './TaskCheck.svelte';

  /** The month (plate 5, « même habillage que la semaine »): six weeks, three items a day, then « +N ». */

  interface Props {
    days: Date[];
    month: number;
    items: AgendaItem[];
    now: Date;
    selected?: string | undefined;
    color: (calendarId: string) => string;
    onopen: (event: AgendaEvent, anchor: HTMLElement) => void;
    onedit: (task: AgendaTask) => void;
    ontoggle: (task: AgendaTask) => void;
    /** Opens a day (its number, or « +N »). */
    onday: (day: Date) => void;
  }
  let { days, month, items, now, selected, color, onopen, onedit, ontoggle, onday }: Props = $props();
  const MAX = 3;
  const weekdays = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
  const today = $derived(dayKey(now));
</script>

<div class="mois">
  {#each weekdays as w (w)}<p class="jsem" aria-hidden="true">{w}</p>{/each}
  {#each days as day (dayKey(day))}
    {@const list = itemsOn(items, day)}
    <section
      class={['cell', { autre: day.getMonth() !== month, we: day.getDay() === 0 || day.getDay() === 6 }]}
      aria-label={dayName(day)}
    >
      <button
        type="button"
        class={['num', { auj: dayKey(day) === today }]}
        aria-label={`Ouvrir le ${dayName(day)}`}
        onclick={() => onday(day)}>{day.getDate()}</button
      >
      {#each list.slice(0, MAX) as item (itemKey(item))}
        {#if item.kind === 'event'}
          <button
            type="button"
            class={['pastille', { entier: item.allDay, sel: selected === itemKey(item) }]}
            style:--c={color(item.calendarId)}
            aria-label={`${item.title}, ${item.allDay ? 'journée entière' : timeOf(item.start)}`}
            onclick={(e) => onopen(item, e.currentTarget)}
          >
            {#if !item.allDay}<i aria-hidden="true"></i><span class="h">{timeOf(item.start)}</span>{/if}
            <span class="t">{item.title}</span>
          </button>
        {:else}
          <div class={['tache', { fait: item.done, retard: !item.done && dayKey(day) < today }]}>
            <TaskCheck title={item.title} done={item.done} size="petit" ontoggle={() => ontoggle(item)} />
            <button type="button" class="t" onclick={() => onedit(item)}>{item.title}</button>
          </div>
        {/if}
      {/each}
      {#if list.length > MAX}
        <button type="button" class="plus" onclick={() => onday(day)}>{list.length - MAX} de plus</button>
      {/if}
    </section>
  {/each}
</div>

<style>
  .mois {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    grid-template-rows: auto repeat(6, minmax(96px, 1fr));
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: var(--pina-coin);
    box-sizing: border-box;
  }
  .jsem {
    margin: 0;
    padding: 10px 0 6px;
    border-left: 1px solid var(--bordure);
    border-bottom: 1px solid var(--bordure);
    font: 500 10.5px var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    text-align: center;
    color: var(--texte-3);
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 4px 4px 6px;
    border-left: 1px solid var(--bordure);
    border-bottom: 1px solid var(--bordure);
  }
  .cell.we {
    background-color: color-mix(in srgb, var(--texte) 1.5%, transparent);
  }
  .num {
    display: grid;
    place-items: center;
    align-self: center;
    width: 26px;
    height: 26px;
    margin-bottom: 2px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--texte-2);
    font: 400 12.5px var(--sans);
    cursor: pointer;
  }
  .num:hover {
    background: var(--survol);
  }
  .num.auj {
    background: var(--accent);
    color: var(--texte);
  }
  .autre .num,
  .autre .pastille,
  .autre .tache {
    opacity: 0.45;
  }
  .pastille {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    height: 20px;
    padding: 0 6px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--texte);
    font: 300 11.5px var(--sans);
    text-align: left;
    cursor: pointer;
  }
  .pastille:hover {
    background: var(--survol);
  }
  .pastille i {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c);
  }
  .pastille .h {
    flex: none;
    color: var(--texte-3);
  }
  .pastille.entier {
    background: color-mix(in srgb, var(--c) 28%, transparent);
  }
  .pastille.sel {
    outline: 2px solid var(--texte);
    outline-offset: 1px;
  }
  .t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tache {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 20px;
    padding: 0 6px;
    border: 1px dashed var(--bordure-forte);
    border-radius: 5px;
    color: var(--texte-2);
    font-size: 11.5px;
  }
  .tache .t {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tache.fait .t {
    color: var(--texte-3);
    text-decoration: line-through;
  }
  .tache.retard {
    border-color: var(--attention-bord);
    color: var(--attention);
  }
  .plus {
    align-self: flex-start;
    padding: 0 6px;
    border: 0;
    background: none;
    color: var(--texte-3);
    font: 400 11.5px var(--sans);
    cursor: pointer;
  }
  .plus:hover {
    color: var(--texte);
  }
  @media (max-width: 767.98px) {
    .mois {
      grid-template-rows: auto repeat(6, minmax(72px, 1fr));
    }
    .pastille .h,
    .pastille i {
      display: none;
    }
    .pastille,
    .tache {
      padding: 0 3px;
      font-size: 10.5px;
    }
  }
</style>
