<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { AgendaItem, AgendaTask } from '../types.ts';
  import { addDays, dayKey, startOfDay, step, title, visibleDays, type Editing, type Mode } from './dates.ts';
  import DayView from './DayView.svelte';
  import ItemChip from './ItemChip.svelte';
  import ItemEditor from './ItemEditor.svelte';
  import MonthView from './MonthView.svelte';
  import WeekView from './WeekView.svelte';

  let { client, today = new Date() }: { client: AcediaClient; today?: Date } = $props();

  let mode = $state<Mode>('week');
  let cursor = $state(untrack(() => startOfDay(today)));
  let items = $state<AgendaItem[]>([]);
  let undated = $state<AgendaTask[]>([]);
  let editing = $state<Editing | null>(null);
  let error = $state<string | null>(null);

  const days = $derived(visibleDays(mode, cursor));
  const modes: { id: Mode; name: string }[] = [
    { id: 'day', name: 'Jour' },
    { id: 'week', name: 'Semaine' },
    { id: 'month', name: 'Mois' },
  ];

  async function load(shown: Date[]) {
    try {
      items = await client.agenda(dayKey(shown[0]!), dayKey(addDays(shown.at(-1)!, 1)));
    } catch (err) {
      error = errorText(err);
    }
  }

  async function loadUndated() {
    try {
      undated = await client.undatedTasks();
    } catch (err) {
      error = errorText(err);
    }
  }

  $effect(() => {
    void load(days);
  });
  onMount(() => {
    void loadUndated();
    return client.subscribe((e) => {
      if (e.type === 'agenda.changed') {
        void load(days);
        void loadUndated();
      }
    });
  });

  const replace = (list: AgendaItem[], next: AgendaItem) =>
    list.map((i) => (i.kind === next.kind && i.id === next.id ? next : i));

  /** Ticks or unticks a task where it stands; puts it back if the server refuses. */
  async function toggle(item: AgendaItem) {
    if (item.kind !== 'task') return;
    error = null;
    const flipped = { ...item, done: !item.done };
    items = replace(items, flipped);
    undated = undated.map((t) => (t.id === item.id ? flipped : t));
    try {
      const saved = await client.completeTask(item.listId, item.id, flipped.done);
      items = replace(items, saved);
      undated = undated.map((t) => (t.id === item.id ? saved : t));
    } catch (err) {
      items = replace(items, item);
      undated = undated.map((t) => (t.id === item.id ? item : t));
      error = errorText(err);
    }
  }

  function saved() {
    editing = null;
    void load(days);
    void loadUndated();
  }
</script>

<div class="agenda lun-acedia" data-monde="acedia">
  <header class="bar">
    <div class="nav">
      <button type="button" aria-label="Précédent" onclick={() => (cursor = step(mode, cursor, -1))}>‹</button
      >
      <button type="button" onclick={() => (cursor = startOfDay(today))}>Aujourd’hui</button>
      <button type="button" aria-label="Suivant" onclick={() => (cursor = step(mode, cursor, 1))}>›</button>
    </div>
    <h2>{title(mode, cursor)}</h2>
    <div class="modes" role="group" aria-label="Affichage">
      {#each modes as m (m.id)}
        <button type="button" aria-pressed={mode === m.id} onclick={() => (mode = m.id)}>{m.name}</button>
      {/each}
    </div>
    <div class="create">
      <button type="button" onclick={() => (editing = { kind: 'event', day: cursor })}
        >Nouvel événement</button
      >
      <button type="button" onclick={() => (editing = { kind: 'task', day: cursor })}>Nouvelle tâche</button>
    </div>
  </header>

  {#if error}
    <p class="error" role="alert">
      {error}
      <button type="button" aria-label="Fermer le message" onclick={() => (error = null)}>×</button>
    </p>
  {/if}

  <div class="body">
    <div class="view">
      {#if mode === 'day'}
        <DayView day={cursor} {items} {today} onedit={(i) => (editing = i)} ontoggle={toggle} />
      {:else if mode === 'week'}
        <WeekView {days} {items} {today} onedit={(i) => (editing = i)} ontoggle={toggle} />
      {:else}
        <MonthView
          {days}
          month={cursor.getMonth()}
          {items}
          {today}
          onedit={(i) => (editing = i)}
          ontoggle={toggle}
          onday={(d) => ((cursor = d), (mode = 'day'))}
        />
      {/if}
    </div>
    <aside class="undated" aria-label="Sans échéance">
      <h3>Sans échéance</h3>
      {#each undated as task (task.id)}
        <ItemChip item={task} onedit={() => (editing = task)} ontoggle={() => toggle(task)} />
      {:else}
        <p class="empty">Aucune tâche.</p>
      {/each}
    </aside>
  </div>
</div>

{#if editing}
  {#key editing}
    <ItemEditor {client} {editing} onclose={() => (editing = null)} onsaved={saved} ondeleted={saved} />
  {/key}
{/if}

<style>
  .agenda {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--bordure);
  }
  .bar h2 {
    flex: 1;
    margin: 0;
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.35rem;
    text-transform: capitalize;
  }
  .nav,
  .modes,
  .create {
    display: flex;
    gap: 0.35rem;
  }
  .modes button[aria-pressed='true'] {
    background: var(--accent-doux);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 15rem;
  }
  .view {
    overflow: auto;
  }
  .undated {
    padding: 0.6rem;
    border-left: 1px solid var(--bordure);
    overflow-y: auto;
  }
  .undated h3 {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--lavis);
  }
  .empty {
    font-size: 0.8rem;
    color: var(--lune);
  }
  .error {
    display: flex;
    justify-content: space-between;
    margin: 0.5rem 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--rayon);
    background: rgba(122, 24, 24, 0.35);
  }
  @media (max-width: 899px) {
    .body {
      grid-template-columns: 1fr;
    }
    .undated {
      border-left: 0;
      border-top: 1px solid var(--bordure);
    }
  }
</style>
