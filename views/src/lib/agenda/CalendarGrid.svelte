<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgendaEvent, AgendaItem, AgendaTask } from '../types.ts';
  import { allDayBars, dayKey, dayName, hours, itemKey, layoutDay, timeOf, weekday } from './dates.ts';
  import TaskCheck from './TaskCheck.svelte';

  /*
   * The hour grid of a day or a week (plate 5): day heads, a band of all-day events and one of the
   * tasks due, then 24 hours with the current time line. Overlapping events sit side by side.
   */

  interface Props {
    days: Date[];
    items: AgendaItem[];
    /** Now: the current day and the time line. */
    now: Date;
    /** Event whose bubble is open. */
    selected?: string | undefined;
    color: (calendarId: string) => string;
    onopen: (event: AgendaEvent, anchor: HTMLElement) => void;
    onedit: (task: AgendaTask) => void;
    ontoggle: (task: AgendaTask) => void;
    /** A click in an empty slot: creates an event there. */
    oncreate: (day: Date, hour: number) => void;
  }
  let { days, items, now, selected, color, onopen, onedit, ontoggle, oncreate }: Props = $props();

  const HOUR = 48;
  const today = $derived(dayKey(now));
  const bars = $derived(allDayBars(items, days));
  const rows = $derived(Math.max(1, ...bars.map((b) => b.row + 1)));
  const tasksOf = (day: Date) =>
    items.filter((i): i is AgendaTask => i.kind === 'task' && i.due === dayKey(day));
  const weekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
  const nowTop = $derived(((now.getHours() * 60 + now.getMinutes()) * HOUR) / 60);

  let scroller = $state<HTMLElement | null>(null);
  // Opens on the working hours, as a paper diary does.
  onMount(() => {
    if (scroller) scroller.scrollTop = 8 * HOUR - 12;
  });

  function slot(event: MouseEvent, day: Date) {
    if (event.target !== event.currentTarget) return;
    const y = event.offsetY;
    oncreate(day, Math.max(0, Math.min(23, Math.floor(y / HOUR))));
  }

  const label = (e: AgendaEvent) => `${e.title}, ${e.allDay ? 'journée entière' : hours(e)}`;
  /** The day heads are drawn only: a bar says the days it covers. */
  const barLabel = (bar: { event: AgendaEvent; col: number; span: number }) => {
    const first = dayName(days[bar.col]!);
    const last = dayName(days[bar.col + bar.span - 1]!);
    return `${bar.event.title}, journée entière, ${bar.span > 1 ? `du ${first} au ${last}` : first}`;
  };
</script>

<div class="grille" style:--jours={days.length} style:--heure="{HOUR}px">
  <div class="tetes ligne" aria-hidden="true">
    <span></span>
    {#each days as day (dayKey(day))}
      <div class={['jt', { auj: dayKey(day) === today, we: weekend(day) }]}>
        <small>{weekday(day)}</small><b>{day.getDate()}</b>
      </div>
    {/each}
  </div>

  <div class="bande ligne" style:--rangs={rows}>
    <span class="lib">jour</span>
    <div class="cases">
      {#each days as day, i (dayKey(day))}
        <span class="case" style:grid-column={i + 1} style:grid-row="1 / span {rows}"></span>
      {/each}
      {#each bars as bar (itemKey(bar.event))}
        <button
          type="button"
          class={['entier', { sel: selected === itemKey(bar.event) }]}
          style:--c={color(bar.event.calendarId)}
          style:grid-column="{bar.col + 1} / span {bar.span}"
          style:grid-row={bar.row + 1}
          aria-label={barLabel(bar)}
          onclick={(e) => onopen(bar.event, e.currentTarget)}>{bar.event.title}</button
        >
      {/each}
    </div>
  </div>

  <div class="bande ligne taches">
    <span class="lib">tâches</span>
    <div class="cases">
      {#each days as day, i (dayKey(day))}
        <div class="case" style:grid-column={i + 1}>
          {#each tasksOf(day) as task (itemKey(task))}
            <div class={['tache', { fait: task.done, retard: !task.done && dayKey(day) < today }]}>
              <TaskCheck title={task.title} done={task.done} size="petit" ontoggle={() => ontoggle(task)} />
              <button
                type="button"
                class="nom"
                aria-label={`${task.title}, tâche du ${dayName(day)}`}
                onclick={() => onedit(task)}>{task.title}</button
              >
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>

  <div class="defile" bind:this={scroller}>
    <div class="heures" aria-hidden="true">
      {#each { length: 23 } as _, h (h)}
        <span style:top="{(h + 1) * HOUR}px">{String(h + 1).padStart(2, '0')}:00</span>
      {/each}
    </div>
    {#each days as day (dayKey(day))}
      <!-- A click in a slot is a pointer shortcut: C and « Créer » do the same from the keyboard. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <div
        class={['col', { we: weekend(day) }]}
        role="region"
        aria-label={dayName(day)}
        onclick={(e) => slot(e, day)}
      >
        {#if dayKey(day) === today}<div class="maint" style:top="{nowTop}px" aria-hidden="true"></div>{/if}
        {#each layoutDay(items, day) as p (itemKey(p.event))}
          {@const short = p.bottom - p.top < 45}
          <button
            type="button"
            class={['ev', { court: short, sel: selected === itemKey(p.event) }]}
            style:--c={color(p.event.calendarId)}
            style:top="{(p.top * HOUR) / 60}px"
            style:height="{Math.max(20, ((p.bottom - p.top) * HOUR) / 60 - 2)}px"
            style:left="calc({(p.lane / p.lanes) * 100}% + 3px)"
            style:width="calc({100 / p.lanes}% - 7px)"
            aria-label={label(p.event)}
            onclick={(e) => onopen(p.event, e.currentTarget)}
          >
            <b>{p.event.title}</b>
            <span
              >{short ? timeOf(p.event.start) : hours(p.event)}{#if p.event.location && !short}{' · '}{p.event
                  .location}{/if}</span
            >
          </button>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .grille {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  /* Every row keeps the gutter of the scroll bar, so the columns line up with the hours below. */
  .ligne,
  .defile {
    display: grid;
    grid-template-columns: 56px repeat(var(--jours), minmax(0, 1fr));
    overflow-y: hidden;
    scrollbar-gutter: stable;
  }
  .ligne {
    flex: none;
    border-bottom: 1px solid var(--bordure);
  }
  .jt {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: 58px;
    border-left: 1px solid var(--bordure);
  }
  .jt small {
    font: 500 10.5px var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--texte-3);
  }
  .jt b {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    font: 400 20px var(--sans);
  }
  .jt.we b {
    color: var(--texte-2);
  }
  .jt.auj small {
    color: var(--accent-texte);
  }
  .jt.auj b {
    background: var(--accent);
    color: var(--texte);
  }
  .lib {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 8px;
    font-size: 10.5px;
    color: var(--texte-3);
  }
  .cases {
    grid-column: 2 / -1;
    display: grid;
    grid-template-columns: repeat(var(--jours), minmax(0, 1fr));
    grid-auto-rows: 22px;
    row-gap: 3px;
    padding: 3px 0;
    min-height: 24px;
  }
  .case {
    border-left: 1px solid var(--bordure);
    margin: -3px 0;
  }
  .taches .cases {
    grid-auto-rows: auto;
  }
  .taches .case {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    margin: -3px 0;
    padding: 3px;
  }
  .entier {
    position: relative;
    z-index: 1;
    min-width: 0;
    height: 22px;
    margin: 0 4px 0 3px;
    padding: 0 8px;
    border: 0;
    border-radius: 5px;
    background: color-mix(in srgb, var(--c) 28%, transparent);
    color: var(--texte);
    font: 400 11.5px/22px var(--sans);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .tache {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 22px;
    padding: 0 6px;
    border: 1px dashed var(--bordure-forte);
    border-radius: 5px;
    color: var(--texte-2);
    font-size: 11.5px;
  }
  .tache .nom {
    min-width: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .tache.fait .nom {
    color: var(--texte-3);
    text-decoration: line-through;
  }
  .tache.retard {
    border-color: var(--attention-bord);
    color: var(--attention);
  }
  .defile {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: var(--pina-coin);
    position: relative;
  }
  .heures {
    position: relative;
    height: calc(24 * var(--heure));
  }
  .heures span {
    position: absolute;
    right: 8px;
    font-size: 10.5px;
    color: var(--texte-3);
    transform: translateY(-7px);
  }
  .col {
    position: relative;
    height: calc(24 * var(--heure));
    border-left: 1px solid var(--bordure);
    background-image: repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent calc(var(--heure) - 1px),
      var(--bordure) calc(var(--heure) - 1px),
      var(--bordure) var(--heure)
    );
  }
  .col.we,
  .jt.we {
    background-color: color-mix(in srgb, var(--texte) 1.5%, transparent);
  }
  .ev {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 4px 7px;
    border: 0;
    border-radius: 6px;
    background: color-mix(in srgb, var(--c) 28%, var(--fond));
    box-shadow: inset 3px 0 0 var(--c);
    color: var(--texte);
    font: 300 11.5px/1.3 var(--sans);
    text-align: left;
    overflow: hidden;
    cursor: pointer;
  }
  .ev b {
    max-width: 100%;
    font-weight: 500;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ev span {
    max-width: 100%;
    color: var(--texte-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ev.court {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
    padding-bottom: 2px;
  }
  .ev.court span {
    flex: none;
  }
  .ev:hover,
  .entier:hover {
    filter: brightness(1.12);
  }
  .ev.sel,
  .entier.sel {
    outline: 2px solid var(--texte);
    outline-offset: 1px;
  }
  .ev:focus-visible,
  .entier:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 1px;
  }
  .maint {
    position: absolute;
    left: -5px;
    right: 0;
    z-index: 3;
    height: 2px;
    background: var(--danger);
    pointer-events: none;
  }
  .maint::before {
    content: '';
    position: absolute;
    left: 0;
    top: -4px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--danger);
  }
</style>
