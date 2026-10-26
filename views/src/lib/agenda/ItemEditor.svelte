<script lang="ts">
  import { untrack } from 'svelte';
  import type { AcediaClient, EventDraft, TaskDraft } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { AgendaItem } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { Bell, Calendar, Clock, FileText, ICON_STROKE, List, MapPin, Plus, Trash, X } from '../ui/Icon.ts';
  import Menu from '../ui/Menu.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import Select from '../ui/Select.svelte';
  import Switch from '../ui/Switch.svelte';
  import {
    addDays,
    dayKey,
    fromLocalInput,
    parseDay,
    reminderName,
    toLocalInput,
    type Editing,
  } from './dates.ts';

  /*
   * One window to create or change an event or a task (plate 5): the kind on top (new items only),
   * the title first, then lines with an icon, as on Google Agenda. Rare options (reminders, a note)
   * stay folded until asked for.
   */

  interface Container {
    id: string;
    title: string;
    color: string;
  }
  interface Props {
    client: AcediaClient;
    editing: Editing;
    calendars: Container[];
    lists: Container[];
    onclose: () => void;
    onsaved: (item: AgendaItem) => void;
    /** Asks to remove the item (the caller confirms). */
    ondelete: (item: AgendaItem) => void;
  }
  let { client, editing, calendars, lists, onclose, onsaved, ondelete }: Props = $props();

  // The form starts from the item, then belongs to the person editing.
  const item = untrack(() => ('id' in editing ? editing : undefined));
  const event = item?.kind === 'event' ? item : undefined;
  const task = item?.kind === 'task' ? item : undefined;
  const day = untrack(() => ('day' in editing ? editing.day : new Date()));
  const hour = untrack(() => ('hour' in editing && editing.hour !== undefined ? editing.hour : 9));
  const pad = (n: number) => String(n).padStart(2, '0');

  let open = $state(true);
  let kind = $state(untrack(() => editing.kind));
  let titleText = $state(item?.title ?? '');
  let calendarId = $state(event?.calendarId ?? '');
  let listId = $state(task?.listId ?? '');
  let allDay = $state(event?.allDay ?? false);
  let date = $state(
    event ? (event.allDay ? event.start : toLocalInput(event.start).slice(0, 10)) : dayKey(day),
  );
  // All-day: the last day, included. Timed: the day of the end (Google's end is exclusive for days only).
  let endDate = $state(
    event
      ? event.allDay
        ? dayKey(addDays(parseDay(event.end), -1))
        : toLocalInput(event.end).slice(0, 10)
      : dayKey(day),
  );
  let startTime = $state(event && !event.allDay ? toLocalInput(event.start).slice(11) : `${pad(hour)}:00`);
  let endTime = $state(
    event && !event.allDay
      ? toLocalInput(event.end).slice(11)
      : `${pad(Math.min(hour + 1, 23))}:${hour === 23 ? '59' : '00'}`,
  );
  // The when fields as loaded: untouched, the event keeps its own start and end strings, whatever
  // they are (zero length, the hour repeated when the clocks go back).
  const initial = untrack(() => ({ allDay, date, endDate, startTime, endTime }));
  const whenTouched = () =>
    allDay !== initial.allDay ||
    date !== initial.date ||
    endDate !== initial.endDate ||
    startTime !== initial.startTime ||
    endTime !== initial.endTime;
  let showEnd = $state(untrack(() => endDate !== date));
  let location = $state(event?.location ?? '');
  // Untouched, the reminders stay those of the calendar: they are only sent once changed here.
  let reminders = $state(event?.reminders ?? []);
  let remindersTouched = $state(false);
  let due = $state(task ? (task.due ?? '') : dayKey(day));
  let notes = $state(task?.notes ?? '');
  let showNotes = $state(Boolean(task?.notes));
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!calendarId && calendars[0]) calendarId = calendars[0].id;
    if (!listId && lists[0]) listId = lists[0].id;
  });
  $effect(() => {
    if (!open) onclose();
  });

  const dialogTitle = $derived(
    kind === 'event'
      ? item
        ? 'Modifier l’événement'
        : 'Nouvel événement'
      : item
        ? 'Modifier la tâche'
        : 'Nouvelle tâche',
  );
  const CHOICES = [10, 30, 60, 1440];

  function setReminders(next: number[]) {
    reminders = [...new Set(next)].sort((a, b) => a - b);
    remindersTouched = true;
  }

  /** Moving the first day moves the last one with it, as on Google Agenda. */
  function moveDate(next: string) {
    if (next && date) {
      const shift = Math.round((parseDay(next).getTime() - parseDay(date).getTime()) / 86_400_000);
      endDate = dayKey(addDays(parseDay(endDate), shift));
    }
    date = next;
  }

  /**
   * Start and end of a timed event. On one day, an end time not after the start ends the next day
   * (a night).
   */
  function timedRange() {
    const start = fromLocalInput(`${date}T${startTime}`);
    const endDay = endDate === date && endTime <= startTime ? dayKey(addDays(parseDay(date), 1)) : endDate;
    const end = fromLocalInput(`${endDay}T${endTime}`);
    if (Date.parse(end) <= Date.parse(start)) throw new Error('La fin doit suivre le début.');
    return { start, end };
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!titleText.trim()) return;
    busy = true;
    error = null;
    try {
      if (kind === 'event') {
        const draft: EventDraft = {
          calendarId,
          title: titleText.trim(),
          allDay,
          ...(event && !whenTouched()
            ? { start: event.start, end: event.end }
            : allDay
              ? { start: date, end: dayKey(addDays(parseDay(endDate < date ? date : endDate), 1)) }
              : timedRange()),
        };
        if (event) draft.id = event.id;
        if (location || event?.location) draft.location = location;
        if (remindersTouched) draft.reminders = reminders;
        onsaved(await client.saveEvent(draft));
      } else {
        const draft: TaskDraft = { listId, title: titleText.trim(), due: due || null };
        if (task) draft.id = task.id;
        if (notes || task?.notes) draft.notes = notes;
        onsaved(await client.saveTask(draft));
      }
      open = false;
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  }

  const options = (list: Container[]) => list.map((c) => ({ value: c.id, label: c.title }));
  const colorOf = (list: Container[], id: string) => list.find((c) => c.id === id)?.color;
</script>

<Dialog bind:open title={dialogTitle} width={520}>
  {#snippet children()}
    <form id="fenetre-agenda" class="champs" onsubmit={save}>
      {#if !item}
        <Segmented
          label="Type"
          size="petit"
          options={[
            { value: 'event', label: 'Événement' },
            { value: 'task', label: 'Tâche' },
          ]}
          bind:value={() => kind, (v) => (kind = v as 'event' | 'task')}
          class="type"
        />
      {/if}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="titre"
        aria-label="Titre"
        placeholder="Ajouter un titre"
        bind:value={titleText}
        required
        autofocus
      />

      {#if kind === 'event'}
        <div class="ligne">
          <Clock size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input class="puce" type="date" aria-label="Date" bind:value={() => date, moveDate} required />
          {#if allDay}
            <span aria-hidden="true">–</span>
            <input
              class="puce"
              type="date"
              aria-label="Dernier jour"
              bind:value={endDate}
              min={date}
              required
            />
          {:else}
            <span class="plage">
              <input class="puce heure" type="time" aria-label="Début" bind:value={startTime} required />
              <span aria-hidden="true">–</span>
              <input class="puce heure" type="time" aria-label="Fin" bind:value={endTime} required />
            </span>
            {#if showEnd || endDate !== date}
              <!-- An event over several days: its end keeps its own day. -->
              <input
                class="puce fin"
                type="date"
                aria-label="Date de fin"
                bind:value={endDate}
                min={date}
                required
              />
            {:else}
              <Button variant="fantome" size="petit" icon={Plus} class="fin" onclick={() => (showEnd = true)}
                >Date de fin</Button
              >
            {/if}
          {/if}
        </div>
        <div class="ligne bascule">
          <Switch aria-labelledby="journee" bind:checked={allDay} /><span id="journee">Journée entière</span>
        </div>
        <div class="ligne">
          <MapPin size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input class="puce large" aria-label="Lieu" placeholder="Ajouter un lieu" bind:value={location} />
        </div>
        <div class="ligne">
          <Calendar size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span class="couleur" style:background={colorOf(calendars, calendarId)} aria-hidden="true"></span>
          <Select
            aria-label="Agenda"
            class="choix"
            items={options(calendars)}
            bind:value={calendarId}
            disabled={item !== undefined}
          />
        </div>
        <div class="ligne">
          <Bell size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {#each reminders as minutes (minutes)}
            <span class="puce">
              {reminderName(minutes)}
              <button
                type="button"
                class="retirer"
                aria-label={`Retirer le rappel ${reminderName(minutes)}`}
                onclick={() => setReminders(reminders.filter((m) => m !== minutes))}
                ><X size={12} strokeWidth={ICON_STROKE} aria-hidden="true" /></button
              >
            </span>
          {/each}
          <Menu
            sections={[
              {
                items: CHOICES.filter((m) => !reminders.includes(m)).map((m) => ({
                  id: String(m),
                  label: reminderName(m),
                  onselect: () => setReminders([...reminders, m]),
                })),
              },
            ]}
          >
            {#snippet trigger({ props })}
              <Button {...props} variant="fantome" size="petit" icon={Plus}>Rappel</Button>
            {/snippet}
          </Menu>
        </div>
      {:else}
        <div class="ligne">
          <Clock size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input class="puce" type="date" aria-label="Échéance" bind:value={due} />
          {#if due}<Button variant="fantome" size="petit" onclick={() => (due = '')}>Sans date</Button>{/if}
        </div>
        <div class="ligne">
          <List size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span class="couleur" style:background={colorOf(lists, listId)} aria-hidden="true"></span>
          <Select
            aria-label="Liste"
            class="choix"
            items={options(lists)}
            bind:value={listId}
            disabled={item !== undefined}
          />
        </div>
        <div class="ligne haut">
          <FileText size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {#if showNotes}
            <textarea class="puce large" aria-label="Note" rows="3" bind:value={notes}></textarea>
          {:else}
            <Button variant="fantome" size="petit" icon={Plus} onclick={() => (showNotes = true)}>Note</Button
            >
          {/if}
        </div>
      {/if}
      {#if error}<p class="erreur" role="alert">{error}</p>{/if}
    </form>
  {/snippet}
  {#snippet footer({ close })}
    {#if item}
      <Button variant="danger" icon={Trash} class="agenda-supprimer" onclick={() => ondelete(item)}
        >Supprimer</Button
      >
    {/if}
    <Button variant="secondaire" onclick={close}>Annuler</Button>
    <Button
      type="submit"
      form="fenetre-agenda"
      variant="principal"
      loading={busy}
      disabled={!titleText.trim()}>Enregistrer</Button
    >
  {/snippet}
</Dialog>

<style>
  .champs {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .champs :global(.type) {
    align-self: flex-start;
  }
  .titre {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 0 6px;
    border: 0;
    border-bottom: 1px solid var(--accent-texte);
    border-radius: 0;
    background: none;
    color: var(--texte);
    font: 500 24px var(--serif);
  }
  .titre:focus-visible {
    outline: none;
    border-bottom-width: 2px;
    padding-bottom: 5px;
  }
  .titre::placeholder {
    color: var(--texte-3);
  }
  .ligne {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 10px;
    font-size: 13.5px;
    color: var(--texte-2);
  }
  .ligne.haut {
    align-items: flex-start;
  }
  .ligne > :global(svg) {
    flex: none;
    color: var(--texte-3);
  }
  .puce {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-1);
    background: var(--surface-1);
    color: var(--texte);
    font: 300 13px var(--sans);
    color-scheme: dark;
  }
  textarea.puce {
    height: auto;
    padding: 6px 10px;
    resize: vertical;
  }
  .puce.large {
    flex: 1;
    min-width: 0;
  }
  .puce::placeholder {
    color: var(--texte-3);
  }
  .puce:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 1px;
  }
  .bascule {
    margin: -4px 0 0 26px;
    font-size: 12.5px;
  }
  .heure {
    width: 76px;
  }
  .plage {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  @media (max-width: 767.98px) {
    .plage,
    .fin,
    .ligne :global(.fin) {
      margin-left: 26px;
    }
  }
  .heure::-webkit-calendar-picker-indicator {
    display: none;
  }
  .ligne :global(.choix) {
    width: 240px;
    max-width: 100%;
  }
  .couleur {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .retirer {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-right: -4px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--texte-3);
    cursor: pointer;
  }
  .retirer:hover {
    background: var(--survol);
    color: var(--texte);
  }
  .erreur {
    margin: 0;
    color: var(--danger);
    font-size: 13px;
  }
  :global(.agenda-supprimer) {
    margin-right: auto;
  }
</style>
