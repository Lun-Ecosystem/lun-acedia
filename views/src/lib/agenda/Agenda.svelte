<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AcediaClient } from '../client.ts';
  import { errorText, toneColor } from '../mail/format.ts';
  import type { AgendaEvent, AgendaItem, AgendaTask } from '../types.ts';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import Chip from '../ui/Chip.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import { Check, ChevronLeft, ChevronRight, Plus, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import NavGroup from '../ui/NavGroup.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import { shellOf } from '../ui/shell.ts';
  import { bindShortcuts } from '../ui/shortcuts.ts';
  import { toast } from '../ui/toasts.svelte.ts';
  import CalendarGrid from './CalendarGrid.svelte';
  import {
    addDays,
    dayKey,
    itemKey,
    startOfDay,
    step,
    title,
    visibleDays,
    type Editing,
    type Mode,
  } from './dates.ts';
  import EventPopover from './EventPopover.svelte';
  import ItemEditor from './ItemEditor.svelte';
  import MiniCalendar from './MiniCalendar.svelte';
  import MonthView from './MonthView.svelte';
  import PlanningView from './PlanningView.svelte';

  /*
   * The agenda (plate 5): day, week, month and planning (the planning by default under 768 px), the
   * small month and the calendars to tick in the rail, a bubble on an event, one window to create.
   * Keys: T today, J and K next and previous period, D W M A the views, C create.
   */

  interface Props {
    client: AcediaClient;
    /** Now, for tests; the time line follows the clock otherwise. */
    today?: Date;
    /** Opens the tasks page (the « Tâches » chip on a phone), when the host has one. */
    ontasks?: (() => void) | undefined;
  }
  let { client, today, ontasks }: Props = $props();

  const phone = () =>
    typeof window !== 'undefined' && (window.matchMedia?.('(max-width: 767.98px)').matches ?? false);

  let now = $state(untrack(() => today ?? new Date()));
  let mode = $state<Mode>(phone() ? 'agenda' : 'week');
  let cursor = $state(untrack(() => startOfDay(now)));
  let items = $state<AgendaItem[]>([]);
  let calendars = $state<{ id: string; title: string }[]>([]);
  let lists = $state<{ id: string; title: string }[]>([]);
  const hidden = new SvelteSet<string>();
  let editing = $state<Editing | null>(null);
  let bubble = $state<{ event: AgendaEvent; anchor: HTMLElement } | null>(null);
  let bubbleOpen = $state(false);
  let removing = $state<AgendaItem | null>(null);
  let error = $state<string | null>(null);

  const days = $derived(visibleDays(mode, cursor));
  const shown = $derived(items.filter((i) => i.kind === 'task' || !hidden.has(i.calendarId)));
  const MODES: { value: Mode; label: string }[] = [
    { value: 'day', label: 'Jour' },
    { value: 'week', label: 'Semaine' },
    { value: 'month', label: 'Mois' },
    { value: 'agenda', label: 'Planning' },
  ];

  const PHONE_MODES = [MODES[3]!, MODES[0]!, MODES[2]!];

  /** The n-th calendar takes the n-th shared tone. */
  const color = (calendarId: string) =>
    toneColor(
      Math.max(
        0,
        calendars.findIndex((c) => c.id === calendarId),
      ),
    );
  const calendarsWithColor = $derived(calendars.map((c) => ({ ...c, color: color(c.id) })));
  const listsWithColor = $derived(lists.map((l, i) => ({ ...l, color: toneColor(i) })));

  let reads = 0;
  async function load(range: Date[]) {
    const seq = ++reads;
    try {
      const next = await client.agenda(dayKey(range[0]!), dayKey(addDays(range.at(-1)!, 1)));
      if (seq === reads) items = next;
    } catch (err) {
      error = errorText(err);
    }
  }

  $effect(() => {
    void load(days);
  });
  onMount(() => {
    client.listCalendars().then(
      (c) => (calendars = c),
      (err) => (error = errorText(err)),
    );
    client.listTaskLists().then(
      (l) => (lists = l),
      (err) => (error = errorText(err)),
    );
    // The time line moves with the clock, unless a test fixed the time.
    const tick = today ? undefined : setInterval(() => (now = new Date()), 60_000);
    const stop = client.subscribe((e) => {
      if (e.type === 'agenda.changed') void load(days);
    });
    return () => {
      clearInterval(tick);
      stop();
    };
  });

  const replace = (list: AgendaItem[], next: AgendaItem) =>
    list.map((i) => (itemKey(i) === itemKey(next) ? next : i));

  /** Ticks or unticks a task where it stands; puts it back if the server refuses. */
  async function toggle(task: AgendaTask) {
    error = null;
    items = replace(items, { ...task, done: !task.done });
    try {
      items = replace(items, await client.completeTask(task.listId, task.id, !task.done));
    } catch (err) {
      items = replace(items, task);
      error = errorText(err);
    }
  }

  function openBubble(event: AgendaEvent, anchor: HTMLElement) {
    bubble = { event, anchor };
    bubbleOpen = true;
  }

  function create(kind: 'event' | 'task' = 'event', day = cursor, hour?: number) {
    bubbleOpen = false;
    editing = hour === undefined ? { kind, day } : { kind, day, hour };
  }

  function saved() {
    void load(days);
  }

  function askRemove(item: AgendaItem) {
    bubbleOpen = false;
    editing = null;
    removing = item;
  }

  async function remove() {
    const item = removing;
    if (!item) return;
    if (item.kind === 'event') await client.deleteEvent(item.calendarId, item.id);
    else await client.deleteTask(item.listId, item.id);
    items = items.filter((i) => itemKey(i) !== itemKey(item));
    toast(item.kind === 'event' ? 'Événement supprimé' : 'Tâche supprimée');
  }

  function view(next: Mode) {
    mode = next;
  }
  const go = (direction: 1 | -1) => (cursor = step(mode, cursor, direction));

  // Keys are the page's only while no window or bubble is open.
  onMount(() =>
    bindShortcuts(
      Object.fromEntries(
        Object.entries({
          t: () => (cursor = startOfDay(now)),
          j: () => go(1),
          k: () => go(-1),
          d: () => view('day'),
          w: () => view('week'),
          m: () => view('month'),
          a: () => view('agenda'),
          c: () => create(),
        }).map(([key, run]) => [key, () => !editing && !bubbleOpen && !removing && run()]),
      ),
    ),
  );

  const shell = shellOf();
  $effect(() => {
    if (!shell) return;
    shell({ action: side, rail: agendas, create: () => create(), createLabel: 'Créer' });
    return () => shell(null);
  });

  const selected = $derived(bubbleOpen && bubble ? itemKey(bubble.event) : undefined);
  const common = $derived({
    items: shown,
    now,
    selected,
    color,
    onopen: openBubble,
    onedit: (t: AgendaTask) => (editing = t),
    ontoggle: toggle,
  });
</script>

{#snippet side()}
  <Button variant="principal" icon={Plus} class="agenda-creer" onclick={() => create()}>Créer</Button>
  <MiniCalendar {cursor} {now} shown={days} onpick={(d) => (cursor = d)} />
{/snippet}

{#snippet agendas()}
  <NavGroup title="Agendas">
    {#each calendarsWithColor as cal (cal.id)}
      <label class="agenda-coche" style:--c={cal.color}>
        <input
          type="checkbox"
          checked={!hidden.has(cal.id)}
          onchange={() => (hidden.has(cal.id) ? hidden.delete(cal.id) : hidden.add(cal.id))}
        />
        <span class="case" aria-hidden="true"><Check size={10} strokeWidth={3.2} /></span>
        <span class="nom">{cal.title}</span>
      </label>
    {/each}
  </NavGroup>
{/snippet}

<div class={['agenda', 'lun-acedia', { seul: !shell }]} data-monde="acedia">
  {#if !shell}
    <aside class="cote">
      {@render side()}
      {@render agendas()}
    </aside>
  {/if}
  <div class="zone">
    <header class="barre">
      <Button variant="secondaire" size="petit" onclick={() => (cursor = startOfDay(now))}>Aujourd’hui</Button
      >
      <span class="fleches">
        <IconButton
          icon={ChevronLeft}
          label="Période précédente"
          shortcut="K"
          size="petit"
          onclick={() => go(-1)}
        />
        <IconButton
          icon={ChevronRight}
          label="Période suivante"
          shortcut="J"
          size="petit"
          onclick={() => go(1)}
        />
      </span>
      <h1>{title(mode, cursor)}</h1>
      <Segmented
        label="Affichage"
        options={MODES}
        value={mode}
        onchange={(v) => view(v as Mode)}
        class="vues"
      />
    </header>
    <div class="puces" role="group" aria-label="Affichage">
      {#each PHONE_MODES as m (m.value)}
        <Chip on={mode === m.value} onclick={() => view(m.value)}>{m.label}</Chip>
      {/each}
      {#if ontasks}<Chip onclick={ontasks}>Tâches</Chip>{/if}
    </div>

    {#if error}
      <Banner title={error} class="agenda-erreur">
        {#snippet action()}
          <IconButton icon={X} label="Fermer le message" size="petit" onclick={() => (error = null)} />
        {/snippet}
      </Banner>
    {/if}

    <div class="vue">
      {#if mode === 'day' || mode === 'week'}
        {#key mode}
          <CalendarGrid {days} {...common} oncreate={(d, h) => create('event', d, h)} />
        {/key}
      {:else if mode === 'month'}
        <MonthView
          {days}
          month={cursor.getMonth()}
          {...common}
          onday={(d) => {
            cursor = d;
            mode = 'day';
          }}
        />
      {:else}
        <PlanningView {days} {...common} />
      {/if}
    </div>
  </div>
</div>

{#if bubble}
  <EventPopover
    event={bubble.event}
    anchor={bubble.anchor}
    side={phone() ? 'bottom' : 'right'}
    bind:open={bubbleOpen}
    calendar={calendars.find((c) => c.id === bubble?.event.calendarId)?.title ?? ''}
    color={color(bubble.event.calendarId)}
    onedit={() => {
      editing = bubble!.event;
      bubbleOpen = false;
    }}
    ondelete={() => askRemove(bubble!.event)}
  />
{/if}

{#if editing}
  {#key editing}
    <ItemEditor
      {client}
      {editing}
      calendars={calendarsWithColor}
      lists={listsWithColor}
      onclose={() => (editing = null)}
      onsaved={saved}
      ondelete={askRemove}
    />
  {/key}
{/if}

<ConfirmDialog
  title={removing?.kind === 'task' ? 'Supprimer la tâche ?' : 'Supprimer l’événement ?'}
  message={`« ${removing?.title ?? ''} » est retiré de Google. Cette action ne s’annule pas ici.`}
  confirmLabel="Supprimer"
  onconfirm={remove}
  bind:open={() => removing !== null, (v) => !v && (removing = null)}
/>

<style>
  .agenda {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .cote {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 12px;
    width: 232px;
    box-sizing: border-box;
    padding: 14px 10px;
    border-right: 1px solid var(--bordure);
    overflow-y: auto;
  }
  :global(.agenda-creer) {
    width: 100%;
    height: 38px;
  }
  .zone {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .barre {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 56px;
    padding: 0 18px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--bordure);
  }
  .fleches {
    display: flex;
    color: var(--texte-2);
  }
  h1 {
    flex: 1;
    min-width: 0;
    margin: 0 0 0 8px;
    font: 500 22px var(--serif);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .puces {
    display: none;
  }
  :global(.agenda-erreur) {
    margin: 10px 18px 0;
  }
  .vue {
    flex: 1;
    min-height: 0;
  }
  .agenda-coche {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--r-1);
    color: var(--texte-2);
    font: 400 13px var(--sans);
    cursor: pointer;
  }
  .agenda-coche:hover {
    background: var(--survol);
    color: var(--texte);
  }
  .agenda-coche input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
  }
  .case {
    display: grid;
    place-items: center;
    flex: none;
    box-sizing: border-box;
    width: 14px;
    height: 14px;
    border: 1.5px solid var(--c);
    border-radius: 4px;
    background: var(--c);
    color: var(--fond);
  }
  .agenda-coche input:not(:checked) + .case {
    background: none;
    border-color: var(--bordure-forte);
    color: transparent;
  }
  .agenda-coche input:not(:checked) ~ .nom {
    color: var(--texte-3);
  }
  .agenda-coche input:focus-visible + .case {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }
  .nom {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 767.98px) {
    .cote {
      display: none;
    }
    .barre {
      height: auto;
      flex-wrap: wrap;
      padding: 4px 14px 8px;
      border-bottom: 0;
    }
    .barre :global(.vues) {
      display: none;
    }
    h1 {
      order: -1;
      margin: 0;
      font-size: 24px;
    }
    .puces {
      display: flex;
      gap: 6px;
      padding: 0 14px 8px;
      overflow-x: auto;
      scrollbar-width: none;
    }
  }
</style>
