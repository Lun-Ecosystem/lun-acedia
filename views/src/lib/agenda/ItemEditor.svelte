<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AcediaClient, EventDraft, TaskDraft } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { AgendaItem } from '../types.ts';
  import { addDays, dayKey, fromLocalInput, parseDay, toLocalInput, type Editing } from './dates.ts';

  interface Props {
    client: AcediaClient;
    editing: Editing;
    onclose: () => void;
    onsaved: (item: AgendaItem) => void;
    ondeleted: (item: AgendaItem) => void;
  }
  let { client, editing, onclose, onsaved, ondeleted }: Props = $props();

  // The form starts from the item, then belongs to the person editing.
  const item = untrack(() => ('id' in editing ? editing : undefined));
  const kind = untrack(() => editing.kind);
  const day = untrack(() => ('day' in editing ? editing.day : new Date()));
  const event = item?.kind === 'event' ? item : undefined;
  const task = item?.kind === 'task' ? item : undefined;

  let containers = $state<{ id: string; title: string }[]>([]);
  let container = $state(event?.calendarId ?? task?.listId ?? '');
  let titleText = $state(item?.title ?? '');
  let allDay = $state(event?.allDay ?? false);
  // All-day: dates, end included in the form (Google's end is exclusive). Timed: local date-times.
  let startDay = $state(event?.allDay ? event.start : dayKey(day));
  let endDay = $state(event?.allDay ? dayKey(addDays(parseDay(event.end), -1)) : dayKey(day));
  let start = $state(event && !event.allDay ? toLocalInput(event.start) : `${dayKey(day)}T09:00`);
  let end = $state(event && !event.allDay ? toLocalInput(event.end) : `${dayKey(day)}T10:00`);
  let location = $state(event?.location ?? '');
  let due = $state(task ? (task.due ?? '') : dayKey(day));
  let notes = $state(task?.notes ?? '');
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    (kind === 'event' ? client.listCalendars() : client.listTaskLists())
      .then((list) => {
        containers = list;
        if (!container && list[0]) container = list[0].id;
      })
      .catch((err) => (error = errorText(err)));
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      if (kind === 'event') {
        const draft: EventDraft = {
          calendarId: container,
          title: titleText,
          allDay,
          start: allDay ? startDay : fromLocalInput(start),
          end: allDay ? dayKey(addDays(parseDay(endDay), 1)) : fromLocalInput(end),
        };
        if (event) draft.id = event.id;
        if (location) draft.location = location;
        onsaved(await client.saveEvent(draft));
      } else {
        const draft: TaskDraft = { listId: container, title: titleText, due: due || null };
        if (task) draft.id = task.id;
        if (notes) draft.notes = notes;
        onsaved(await client.saveTask(draft));
      }
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!item) return;
    busy = true;
    try {
      if (item.kind === 'event') await client.deleteEvent(item.calendarId, item.id);
      else await client.deleteTask(item.listId, item.id);
      ondeleted(item);
    } catch (err) {
      error = errorText(err);
      busy = false;
    }
  }
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="editor" role="dialog" aria-modal="true" aria-label={kind === 'event' ? 'Événement' : 'Tâche'}>
    <form onsubmit={save}>
      <h3>{item ? 'Modifier' : kind === 'event' ? 'Nouvel événement' : 'Nouvelle tâche'}</h3>
      <label
        >{kind === 'event' ? 'Agenda' : 'Liste'}
        <select bind:value={container} disabled={item !== undefined}>
          {#each containers as c (c.id)}<option value={c.id}>{c.title}</option>{/each}
        </select>
      </label>
      <label>Titre <input bind:value={titleText} required /></label>
      {#if kind === 'event'}
        <label class="inline"><input type="checkbox" bind:checked={allDay} /> Journée entière</label>
        {#if allDay}
          <label>Du <input type="date" bind:value={startDay} required /></label>
          <label>Au <input type="date" bind:value={endDay} min={startDay} required /></label>
        {:else}
          <label>Début <input type="datetime-local" bind:value={start} required /></label>
          <label>Fin <input type="datetime-local" bind:value={end} min={start} required /></label>
        {/if}
        <label>Lieu <input bind:value={location} /></label>
      {:else}
        <label>Échéance <input type="date" bind:value={due} /></label>
        <label>Notes <textarea bind:value={notes} rows="3"></textarea></label>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions">
        <button type="submit" disabled={busy || !container}>Enregistrer</button>
        {#if item}<button type="button" class="danger" disabled={busy} onclick={remove}>Supprimer</button
          >{/if}
        <button type="button" onclick={onclose}>Fermer</button>
      </div>
    </form>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.55);
  }
  .editor {
    width: min(28rem, calc(100vw - 2rem));
    padding: 1rem 1.25rem;
    border: 1px solid var(--bordure);
    border-radius: var(--rayon);
    background: var(--surface);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  h3 {
    margin: 0 0 0.25rem;
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.3rem;
  }
  label {
    display: grid;
    grid-template-columns: 6rem 1fr;
    align-items: center;
    font-size: 0.85rem;
    color: var(--lune);
  }
  label.inline {
    display: flex;
    gap: 0.5rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .danger {
    border-color: var(--rouge);
  }
  .error {
    color: #e3a0a0;
  }
</style>
