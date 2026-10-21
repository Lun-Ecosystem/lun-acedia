<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, type AcediaClient } from '../client.ts';
  import type { JournalEntry, LabelView } from '../types.ts';
  import { errorText, shortDate } from './format.ts';

  const ORIGINS = { ai: 'IA', rule: 'Règle', user: 'À la main' } as const;

  let { client }: { client: AcediaClient } = $props();

  let items = $state<JournalEntry[]>([]);
  let cursor = $state<number | undefined>();
  let labels = $state<LabelView[]>([]);
  let error = $state<string | null>(null);

  async function load(more = false) {
    try {
      const page = await client.journal(more ? cursor : undefined);
      items = more ? [...items, ...page.items] : page.items;
      cursor = page.cursor;
    } catch (err) {
      error = errorText(err);
    }
  }

  onMount(() => {
    void load();
    client
      .listLabels()
      .then((l) => (labels = l))
      .catch(() => {});
  });

  const name = (id: string) => labels.find((l) => l.id === id)?.name ?? id;

  function describe(e: JournalEntry): string {
    if (e.action === 'trash') return 'Mis à la corbeille';
    if (e.action === 'spam') return 'Envoyé en spam';
    const box = e.after.find((l) => !e.before.includes(l) && labels.find((x) => x.id === l)?.role === 'box');
    return box ? `Rangé dans ${name(box)}` : 'Rangé';
  }

  async function undo(e: JournalEntry) {
    error = null;
    try {
      await client.undo(e.id);
      items = items.map((x) => (x.id === e.id ? { ...x, undoneAt: new Date().toISOString() } : x));
    } catch (err) {
      error =
        err instanceof ApiError && err.status === 409
          ? 'Le mail a changé depuis, annulation refusée'
          : errorText(err);
    }
  }
</script>

<section class="journal" data-monde="acedia" aria-label="Journal du tri">
  <h2>Journal du tri</h2>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if items.length === 0}<p class="empty">Aucune action automatique pour l’instant.</p>{/if}
  <ul>
    {#each items as e (e.id)}
      <li class:undone={e.undoneAt}>
        <span class="date">{shortDate(e.at)}</span>
        <span class="origin">{ORIGINS[e.origin]}</span>
        <span class="subject">{e.subject || e.messageId}</span>
        <span class="what">{describe(e)}</span>
        {#if e.undoneAt}
          <span class="done">Annulé</span>
        {:else}
          <button type="button" onclick={() => undo(e)}>Annuler</button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if cursor}<button type="button" onclick={() => load(true)}>Plus ancien</button>{/if}
</section>

<style>
  .journal {
    padding: 1rem;
  }
  h2 {
    margin: 0 0 0.75rem;
    font-family: var(--serif);
    font-weight: 500;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--bordure);
  }
  li.undone {
    opacity: 0.55;
  }
  .date,
  .what,
  .done {
    font-size: 0.8rem;
    color: var(--lune);
  }
  .origin {
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    background: var(--accent-doux);
  }
  .subject {
    flex: 1;
    min-width: 10rem;
  }
  .error {
    color: var(--erreur);
  }
  .empty {
    color: var(--lune);
  }
</style>
