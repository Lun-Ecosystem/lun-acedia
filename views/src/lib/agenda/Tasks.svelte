<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import { errorText, toneColor } from '../mail/format.ts';
  import type { AgendaItem, AgendaTask } from '../types.ts';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import Chip from '../ui/Chip.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import { Calendar, Check, ChevronDown, ChevronRight, ICON_STROKE, Plus, Trash, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import Kbd from '../ui/Kbd.svelte';
  import Menu from '../ui/Menu.svelte';
  import NavGroup from '../ui/NavGroup.svelte';
  import NavLink from '../ui/NavLink.svelte';
  import { setScreenContext, shellOf } from '../ui/shell.ts';
  import { toast } from '../ui/toasts.svelte.ts';
  import {
    addDays,
    dayKey,
    itemKey,
    parseDay,
    shortDay,
    startOfDay,
    startOfWeek,
    type Editing,
  } from './dates.ts';
  import ItemEditor from './ItemEditor.svelte';
  import TaskCheck from './TaskCheck.svelte';

  /*
   * The tasks page (plate 5): a page of its own, a one-line add (date and list on chips), the open
   * tasks grouped by due date, the overdue ones in orange, the done ones folded.
   */

  interface Props {
    client: AcediaClient;
    /** Today, for tests. */
    today?: Date;
  }
  let { client, today: fixedToday }: Props = $props();

  const today = untrack(() => startOfDay(fixedToday ?? new Date()));
  const todayKey = dayKey(today);
  const weekEnd = dayKey(addDays(startOfWeek(today), 6));

  let tasks = $state<AgendaTask[]>([]);
  let lists = $state<{ id: string; title: string }[]>([]);
  let calendars = $state<{ id: string; title: string }[]>([]);
  /** The list shown; empty for all of them. */
  let current = $state('');
  let showDone = $state(false);
  let editing = $state<Editing | null>(null);
  let removing = $state<AgendaTask | null>(null);
  let error = $state<string | null>(null);
  let draft = $state({ title: '', due: '', listId: '' });

  const withColor = (all: { id: string; title: string }[]) =>
    all.map((c, i) => ({ ...c, color: toneColor(i) }));
  const listsWithColor = $derived(withColor(lists));
  const listName = (id: string) => lists.find((l) => l.id === id)?.title ?? '';
  const visible = $derived(current ? tasks.filter((t) => t.listId === current) : tasks);
  const open = $derived(visible.filter((t) => !t.done));
  const byDue = (a: AgendaTask, b: AgendaTask) =>
    (a.due ?? '').localeCompare(b.due ?? '') || a.title.localeCompare(b.title);
  const groups = $derived([
    { id: 'retard', name: 'En retard', list: open.filter((t) => t.due && t.due < todayKey).sort(byDue) },
    {
      id: 'semaine',
      name: 'Cette semaine',
      list: open.filter((t) => t.due && t.due >= todayKey && t.due <= weekEnd).sort(byDue),
    },
    { id: 'venir', name: 'À venir', list: open.filter((t) => t.due && t.due > weekEnd).sort(byDue) },
    { id: 'sans', name: 'Sans date', list: open.filter((t) => !t.due).sort(byDue) },
  ]);
  const late = $derived(groups[0]!.list.length);
  const done = $derived(visible.filter((t) => t.done).sort((a, b) => byDue(b, a)));
  const summary = $derived(
    open.length === 0 ? 'Rien à faire.' : `${open.length} à faire${late ? `, dont ${late} en retard` : ''}.`,
  );

  async function load() {
    try {
      tasks = await client.allTasks();
    } catch (err) {
      error = errorText(err);
    }
  }

  /** Server changes come in bursts (a sync touches many tasks): one read after the last of them. */
  const RELOAD_DELAY = 400;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    void load();
    client.listTaskLists().then(
      (l) => {
        lists = l;
        if (!draft.listId && l[0]) draft.listId = l[0].id;
      },
      (err) => (error = errorText(err)),
    );
    client.listCalendars().then(
      (c) => (calendars = c),
      (err) => (error = errorText(err)),
    );
    const stop = client.subscribe((e) => {
      if (e.type !== 'agenda.changed') return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void load(), RELOAD_DELAY);
    });
    return () => {
      stop();
      clearTimeout(reloadTimer);
    };
  });

  const replace = (next: AgendaTask) => (tasks = tasks.map((t) => (itemKey(t) === itemKey(next) ? next : t)));

  async function toggle(task: AgendaTask) {
    error = null;
    replace({ ...task, done: !task.done });
    try {
      replace(await client.completeTask(task.listId, task.id, !task.done));
    } catch (err) {
      replace(task);
      error = errorText(err);
    }
  }

  async function setDue(task: AgendaTask, due: string) {
    error = null;
    try {
      replace(
        await client.saveTask({ id: task.id, listId: task.listId, title: task.title, due: due || null }),
      );
    } catch (err) {
      error = errorText(err);
    }
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title || !draft.listId) return;
    error = null;
    try {
      const saved = await client.saveTask({
        listId: draft.listId,
        title,
        ...(draft.due ? { due: draft.due } : {}),
      });
      tasks = [...tasks, saved];
      draft.title = '';
    } catch (err) {
      error = errorText(err);
    }
  }

  function saved(item: AgendaItem) {
    if (item.kind === 'task') {
      tasks = tasks.some((t) => itemKey(t) === itemKey(item))
        ? tasks.map((t) => (itemKey(t) === itemKey(item) ? item : t))
        : [...tasks, item];
    }
  }

  async function remove() {
    const task = removing;
    if (!task) return;
    await client.deleteTask(task.listId, task.id);
    tasks = tasks.filter((t) => itemKey(t) !== itemKey(task));
    toast('Tâche supprimée');
  }

  /** « sans date », « aujourd’hui », « demain », « lun. 26 oct. » */
  function dueLabel(due: string): string {
    if (!due) return 'sans date';
    if (due === todayKey) return 'aujourd’hui';
    if (due === dayKey(addDays(today, 1))) return 'demain';
    return shortDay(parseDay(due));
  }
  const DUES = [
    { id: 'today', label: 'Aujourd’hui', due: todayKey },
    { id: 'tomorrow', label: 'Demain', due: dayKey(addDays(today, 1)) },
    { id: 'monday', label: 'Lundi prochain', due: dayKey(addDays(startOfWeek(today), 7)) },
    { id: 'none', label: 'Sans date', due: '' },
  ];
  const dueMenu = (choose: (due: string) => void) => [
    { items: DUES.map((d) => ({ id: d.id, label: d.label, onselect: () => choose(d.due) })) },
  ];

  const newTask = () => (editing = { kind: 'task', day: today });
  const select = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    current = id;
    if (id) draft.listId = id;
  };

  const shell = shellOf();
  setScreenContext({
    screen: 'tasks',
    get listId() {
      return current || undefined;
    },
    get label() {
      return lists.find((l) => l.id === current)?.title ?? 'Tâches';
    },
  });
  $effect(() => {
    if (!shell) return;
    shell({ action: side, rail: nav, create: newTask, createLabel: 'Nouvelle tâche' });
    return () => shell(null);
  });

  const countOf = (id: string) => tasks.filter((t) => !t.done && (!id || t.listId === id)).length;
</script>

{#snippet side()}
  <Button variant="principal" icon={Plus} class="taches-nouvelle" onclick={newTask}>Nouvelle tâche</Button>
{/snippet}

{#snippet nav()}
  <NavGroup title="Listes">
    <NavLink
      href="#"
      label="Toutes"
      icon={Check}
      count={countOf('')}
      current={current === ''}
      onclick={select('')}
    />
    {#each listsWithColor as list (list.id)}
      <NavLink
        href="#"
        label={list.title}
        color={list.color}
        count={countOf(list.id)}
        current={current === list.id}
        onclick={select(list.id)}
      />
    {/each}
  </NavGroup>
{/snippet}

{#snippet row(task: AgendaTask)}
  <li class={['trow', { fini: task.done }]}>
    <TaskCheck title={task.title} done={task.done} ontoggle={() => toggle(task)} />
    <div class="corps">
      <button type="button" class="titre" onclick={() => (editing = task)}>{task.title}</button>
      {#if task.due || !current}
        <div class="sous">
          {#if task.due}<span class:retard={!task.done && task.due < todayKey}
              >{shortDay(parseDay(task.due))}</span
            >{/if}
          {#if !current}<span>{listName(task.listId)}</span>{/if}
        </div>
      {/if}
    </div>
    {#if !task.done}
      <div class="actions">
        <Menu sections={dueMenu((due) => setDue(task, due))} label={`Échéance de ${task.title}`}>
          {#snippet trigger({ props })}
            <Button {...props} variant="fantome" size="petit" icon={Calendar}>Date</Button>
          {/snippet}
        </Menu>
        <IconButton icon={Trash} label="Supprimer" size="petit" onclick={() => (removing = task)} />
      </div>
    {/if}
  </li>
{/snippet}

<div class={['taches', 'lun-acedia', { seul: !shell }]} data-monde="acedia">
  {#if !shell}
    <aside class="cote">
      {@render side()}
      {@render nav()}
    </aside>
  {/if}
  <div class="page">
    <div class="contenu">
      <header>
        <h1>{current ? listName(current) : 'Toutes les tâches'}</h1>
        <p>{summary}</p>
      </header>
      <div class="puces" role="group" aria-label="Listes">
        <Chip on={current === ''} onclick={() => (current = '')}>Toutes</Chip>
        {#each lists as list (list.id)}
          <Chip on={current === list.id} onclick={() => ((current = list.id), (draft.listId = list.id))}
            >{list.title}</Chip
          >
        {/each}
      </div>

      {#if error}
        <Banner title={error} class="taches-erreur">
          {#snippet action()}
            <IconButton icon={X} label="Fermer le message" size="petit" onclick={() => (error = null)} />
          {/snippet}
        </Banner>
      {/if}

      <form class="ajout" onsubmit={add}>
        <Plus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <input aria-label="Nouvelle tâche" placeholder="Ajouter une tâche" bind:value={draft.title} />
        <div class="reglages">
          <Menu sections={dueMenu((due) => (draft.due = due))}>
            {#snippet trigger({ props })}
              <button {...props} type="button" class="puce" aria-label={`Échéance : ${dueLabel(draft.due)}`}>
                <Calendar size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />{dueLabel(draft.due)}
              </button>
            {/snippet}
          </Menu>
          <Menu
            sections={[
              {
                items: listsWithColor.map((l) => ({
                  id: l.id,
                  label: l.title,
                  color: l.color,
                  onselect: () => (draft.listId = l.id),
                })),
              },
            ]}
          >
            {#snippet trigger({ props })}
              <button {...props} type="button" class="puce" aria-label={`Liste : ${listName(draft.listId)}`}>
                <span
                  class="pastille"
                  style:background={listsWithColor.find((l) => l.id === draft.listId)?.color}
                  aria-hidden="true"
                ></span>{listName(draft.listId)}
              </button>
            {/snippet}
          </Menu>
          <span class="entree"><Kbd>↵</Kbd></span>
        </div>
      </form>

      {#each groups.filter((g) => g.list.length) as g (g.id)}
        <div class="groupe" role="group" aria-label={`${g.name} · ${g.list.length}`}>
          <h2 class={{ retard: g.id === 'retard' }}>{g.name} · {g.list.length}</h2>
          <ul>
            {#each g.list as task (itemKey(task))}{@render row(task)}{/each}
          </ul>
        </div>
      {:else}
        <EmptyState title="Tout est fait" message="Aucune tâche ouverte dans cette vue." />
      {/each}

      {#if done.length}
        <button type="button" class="replie" aria-expanded={showDone} onclick={() => (showDone = !showDone)}>
          {#if showDone}<ChevronDown
              size={14}
              strokeWidth={ICON_STROKE}
              aria-hidden="true"
            />{:else}<ChevronRight size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />{/if}
          Terminées · {done.length}
        </button>
        {#if showDone}
          <ul>
            {#each done as task (itemKey(task))}{@render row(task)}{/each}
          </ul>
        {/if}
      {/if}
    </div>
  </div>
</div>

{#if editing}
  {#key editing}
    <ItemEditor
      {client}
      {editing}
      calendars={withColor(calendars)}
      lists={listsWithColor}
      onclose={() => (editing = null)}
      onsaved={saved}
      ondelete={(item) => {
        editing = null;
        if (item.kind === 'task') removing = item;
      }}
    />
  {/key}
{/if}

<ConfirmDialog
  title="Supprimer la tâche ?"
  message={`« ${removing?.title ?? ''} » est supprimée de Google Tasks.`}
  confirmLabel="Supprimer"
  onconfirm={remove}
  bind:open={() => removing !== null, (v) => !v && (removing = null)}
/>

<style>
  .taches {
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
  }
  :global(.taches-nouvelle) {
    width: 100%;
    height: 38px;
  }
  .page {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding-bottom: var(--pina-coin);
  }
  .contenu {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 18px 24px 96px;
    box-sizing: border-box;
  }
  header {
    margin-bottom: 12px;
  }
  h1 {
    margin: 0;
    font: 500 30px/1.1 var(--serif);
  }
  header p {
    margin: 4px 0 0;
    font-size: 13.5px;
    color: var(--texte-2);
  }
  .puces {
    display: none;
  }
  :global(.taches-erreur) {
    margin-bottom: 8px;
  }
  .ajout {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    margin-bottom: 8px;
    padding: 0 8px 0 14px;
    box-sizing: border-box;
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
    background: var(--surface-1);
    color: var(--texte-3);
  }
  .ajout:focus-within {
    border-color: var(--accent-bord);
  }
  .ajout input {
    flex: 1;
    min-width: 0;
    height: 42px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--texte);
    font: 300 13.5px var(--sans);
    outline: none;
  }
  .ajout input::placeholder {
    color: var(--texte-3);
  }
  .reglages {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .puce {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-1);
    background: var(--surface-2);
    color: var(--texte);
    font: 300 13px var(--sans);
    white-space: nowrap;
    cursor: pointer;
  }
  .puce:hover {
    background: var(--surface-3);
  }
  .puce:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 1px;
  }
  .pastille {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .groupe h2,
  .replie {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 12px 4px 4px;
    font: 500 10.5px var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--texte-3);
  }
  .groupe h2.retard {
    color: var(--attention);
  }
  .replie {
    align-self: flex-start;
    margin-top: 8px;
    border: 0;
    border-radius: var(--r-1);
    background: none;
    cursor: pointer;
  }
  .replie:hover {
    color: var(--texte);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .trow {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 46px;
    padding: 6px 10px;
    border-radius: var(--r-2);
  }
  .trow:hover,
  .trow:focus-within {
    background: var(--survol);
  }
  .corps {
    flex: 1;
    min-width: 0;
  }
  .titre {
    max-width: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: var(--texte);
    font: 300 14px var(--sans);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fini .titre {
    color: var(--texte-3);
    text-decoration: line-through;
  }
  .sous {
    display: flex;
    gap: 10px;
    font-size: 12px;
    color: var(--texte-3);
  }
  .sous .retard {
    color: var(--attention);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .trow:hover .actions,
  .trow:focus-within .actions {
    opacity: 1;
  }
  @media (max-width: 767.98px) {
    .cote,
    .entree,
    .actions {
      display: none;
    }
    .contenu {
      padding: 4px 14px 120px;
    }
    h1 {
      font-size: 26px;
    }
    .puces {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .ajout {
      flex-wrap: wrap;
      padding: 0 8px 8px 14px;
    }
    .reglages {
      width: 100%;
    }
  }
</style>
