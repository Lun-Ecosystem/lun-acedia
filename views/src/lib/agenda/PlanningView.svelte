<script lang="ts">
  import type { AgendaEvent, AgendaItem, AgendaTask } from '../types.ts';
  import { Calendar } from '../ui/Icon.ts';
  import EmptyState from '../ui/EmptyState.svelte';
  import { dayKey, dayName, hours, itemKey, itemsOn, weekday } from './dates.ts';
  import TaskCheck from './TaskCheck.svelte';

  /** The planning (plate 5, mobile): the days that hold something, tasks first, then the events. */

  interface Props {
    days: Date[];
    items: AgendaItem[];
    now: Date;
    selected?: string | undefined;
    color: (calendarId: string) => string;
    onopen: (event: AgendaEvent, anchor: HTMLElement) => void;
    onedit: (task: AgendaTask) => void;
    ontoggle: (task: AgendaTask) => void;
  }
  let { days, items, now, selected, color, onopen, onedit, ontoggle }: Props = $props();
  const today = $derived(dayKey(now));

  const filled = $derived(
    days
      .map((day) => {
        const list = itemsOn(items, day);
        return {
          day,
          list: [...list.filter((i) => i.kind === 'task'), ...list.filter((i) => i.kind === 'event')],
        };
      })
      .filter((d) => d.list.length > 0),
  );
</script>

<div class="planning">
  {#each filled as { day, list } (dayKey(day))}
    <section class={['jour', { auj: dayKey(day) === today }]} aria-label={dayName(day)}>
      <div class="d" aria-hidden="true"><small>{weekday(day)}</small><b>{day.getDate()}</b></div>
      <div class="evs">
        {#each list as item (itemKey(item))}
          {#if item.kind === 'task'}
            <div class={['tache', { fait: item.done, retard: !item.done && dayKey(day) < today }]}>
              <TaskCheck title={item.title} done={item.done} size="petit" ontoggle={() => ontoggle(item)} />
              <button type="button" class="t" onclick={() => onedit(item)}>{item.title}</button>
            </div>
          {:else}
            <button
              type="button"
              class={['ev', { sel: selected === itemKey(item) }]}
              style:--c={color(item.calendarId)}
              onclick={(e) => onopen(item, e.currentTarget)}
            >
              <b>{item.title}</b>
              <span
                >{item.allDay
                  ? 'Journée entière'
                  : hours(item)}{#if item.location}{' · '}{item.location}{/if}</span
              >
            </button>
          {/if}
        {/each}
      </div>
    </section>
  {:else}
    <EmptyState
      title="Rien de prévu"
      message="Aucun événement ni tâche sur cette période."
      icon={Calendar}
      tone="neutre"
    />
  {/each}
</div>

<style>
  .planning {
    height: 100%;
    overflow-y: auto;
    padding: 0 18px 96px;
    box-sizing: border-box;
  }
  .jour {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 14px;
    max-width: 760px;
    padding: 12px 0;
    border-bottom: 1px solid var(--bordure);
  }
  .d {
    text-align: center;
  }
  .d small {
    display: block;
    font: 500 10px var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--texte-3);
  }
  .d b {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    margin: 2px auto 0;
    border-radius: 50%;
    font: 400 20px var(--sans);
  }
  .auj .d small {
    color: var(--accent-texte);
  }
  .auj .d b {
    background: var(--accent);
  }
  .evs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ev {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: color-mix(in srgb, var(--c) 28%, transparent);
    box-shadow: inset 3px 0 0 var(--c);
    color: var(--texte);
    font: 300 12.5px/1.35 var(--sans);
    text-align: left;
    cursor: pointer;
  }
  .ev b {
    font-weight: 500;
    font-size: 13px;
  }
  .ev span {
    color: var(--texte-2);
  }
  .ev.sel {
    outline: 2px solid var(--texte);
    outline-offset: 1px;
  }
  .tache {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 10px;
    border: 1px dashed var(--bordure-forte);
    border-radius: 6px;
    color: var(--texte-2);
    font-size: 12.5px;
  }
  .tache .t {
    flex: 1;
    min-width: 0;
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
  @media (max-width: 767.98px) {
    .planning {
      padding: 0 14px 96px;
    }
  }
</style>
