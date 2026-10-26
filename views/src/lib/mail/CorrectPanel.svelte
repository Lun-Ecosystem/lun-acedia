<script lang="ts">
  import type { LabelView } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import Checkbox from '../ui/Checkbox.svelte';
  import { Ban, ICON_STROKE, Search, Trash } from '../ui/Icon.ts';
  import Kbd from '../ui/Kbd.svelte';
  import Popover from '../ui/Popover.svelte';
  import { boxColor } from './format.ts';

  /*
   * « Corriger » of a proposal (plate 04): where to file instead (filtered as one types, arrows and
   * Enter), the tags, and whether to remember the sender. Remembering makes a rule, which only takes
   * a box: the option leaves for the trash and spam, and for a group (several senders).
   */

  interface Props {
    open?: boolean | undefined;
    anchor: HTMLElement | null;
    boxes: LabelView[];
    tags: LabelView[];
    /** The AI's target, marked « proposé ». */
    proposed: string | null;
    /** Tags ticked at the start (the AI's). */
    initialTags: string[];
    /** One mail: the sender can be remembered. */
    single: boolean;
    onapply: (boxId: string, tagIds: string[], rememberSender: boolean) => void;
  }
  let {
    open = $bindable(false),
    anchor,
    boxes,
    tags,
    proposed,
    initialTags,
    single,
    onapply,
  }: Props = $props();

  type Target = { id: string; name: string; note?: string };

  let query = $state('');
  let chosen = $state<string | null>(null);
  let picked = $state<string[]>([]);
  let remember = $state(false);

  const fold = (text: string) =>
    text
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();

  const targets = $derived.by((): Target[] => {
    const all: Target[] = [
      ...boxes.map((b) => ({ id: b.id, name: b.name, ...(b.id === proposed ? { note: 'proposé' } : {}) })),
      { id: 'trash', name: 'Corbeille', ...(proposed === 'trash' ? { note: 'proposé' } : {}) },
      { id: 'spam', name: 'Spam', ...(proposed === 'spam' ? { note: 'proposé' } : {}) },
    ];
    const needle = fold(query.trim());
    return needle ? all.filter((t) => fold(t.name).includes(needle)) : all;
  });

  /** The target chosen, else the first one left that is not the AI's. */
  const active = $derived(
    targets.find((t) => t.id === chosen) ?? targets.find((t) => t.id !== proposed) ?? targets[0],
  );
  const rememberable = $derived(
    single && active !== undefined && active.id !== 'trash' && active.id !== 'spam',
  );

  // Each opening starts afresh: nothing typed, the AI's tags, the sender not remembered.
  $effect(() => {
    if (!open) return;
    query = '';
    chosen = null;
    picked = [...initialTags];
    remember = false;
  });

  function step(by: number) {
    if (!targets.length) return;
    const index = active ? targets.indexOf(active) : -1;
    chosen = targets[(index + by + targets.length) % targets.length]!.id;
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    }
  }

  function toggle(id: string) {
    picked = picked.includes(id) ? picked.filter((t) => t !== id) : [...picked, id];
  }

  function apply() {
    if (!active) return;
    onapply(active.id, picked, rememberable && remember);
    open = false;
  }
</script>

<Popover bind:open {anchor} align="end" label="Corriger la proposition" width={290}>
  {#snippet children({ close })}
    <div class="corriger">
      <label class="filtre">
        <Search size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <input
          bind:value={query}
          type="text"
          placeholder="Ranger dans…"
          aria-label="Ranger dans"
          aria-controls="corriger-cibles"
          aria-activedescendant={active ? `cible-${active.id}` : undefined}
          autocomplete="off"
          spellcheck="false"
          {onkeydown}
        />
      </label>
      <div id="corriger-cibles" class="cibles" role="listbox" aria-label="Ranger dans">
        {#each targets as t (t.id)}
          <!-- Chosen from the field's arrows (aria-activedescendant) or by a click. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id="cible-{t.id}"
            role="option"
            tabindex="-1"
            aria-selected={t === active}
            class={['item', { actif: t === active, danger: t.id === 'trash' || t.id === 'spam' }]}
            onclick={() => (chosen = t.id)}
          >
            {#if t.id === 'trash'}
              <Trash size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {:else if t.id === 'spam'}
              <Ban size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {:else}
              <span class="pastille" style:background={boxColor(t.id)} aria-hidden="true"></span>
            {/if}
            <span class="nom">{t.name}</span>
            {#if t.note}<small class="note">{t.note}</small>{/if}
            {#if t === active}<span class="entree"><Kbd>↵</Kbd></span>{/if}
          </div>
        {:else}
          <p class="vide">Aucune boîte de ce nom</p>
        {/each}
      </div>
      {#if tags.length}
        <div class="sep"></div>
        <p class="titre" id="corriger-etiquettes">Étiquettes</p>
        <div class="etiquettes" role="group" aria-labelledby="corriger-etiquettes">
          {#each tags as tag (tag.id)}
            <button
              type="button"
              class={['etiq', { on: picked.includes(tag.id) }]}
              aria-pressed={picked.includes(tag.id)}
              onclick={() => toggle(tag.id)}>{tag.name}</button
            >
          {/each}
        </div>
      {/if}
      {#if rememberable}
        <div class="sep"></div>
        <div class="option"><Checkbox bind:checked={remember} label="Retenir pour cet expéditeur" /></div>
      {/if}
      <div class="pied">
        <Button variant="fantome" size="petit" onclick={close}>Annuler</Button>
        <Button variant="principal" size="petit" disabled={!active} onclick={apply}>Appliquer</Button>
      </div>
    </div>
  {/snippet}
</Popover>

<style>
  .filtre {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    margin: 0 2px 4px;
    padding: 0 8px;
    background: var(--surface-1);
    border: 1px solid var(--bordure);
    border-radius: var(--r-1);
    color: var(--texte-3);
  }
  .filtre:focus-within {
    border-color: var(--accent-bord);
  }
  .filtre :global(svg) {
    flex: none;
  }
  .filtre input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    background: none;
    border: 0;
    color: var(--texte);
    font: 300 12.5px var(--sans);
    outline: none;
  }
  .filtre input::placeholder {
    color: var(--texte-3);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 10px;
    border-radius: var(--r-1);
    font: 400 13.5px var(--sans);
    cursor: pointer;
    user-select: none;
  }
  .item:hover {
    background: var(--survol);
  }
  .item.actif {
    background: var(--appui);
  }
  .item.danger {
    color: var(--danger);
  }
  .item :global(svg) {
    flex: none;
  }
  .pastille {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .nom {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    font-size: 11.5px;
    color: var(--ia);
  }
  .entree {
    margin-left: auto;
  }
  .vide {
    margin: 0;
    padding: 8px 10px;
    font-size: 12.5px;
    color: var(--texte-3);
  }
  .sep {
    height: 1px;
    margin: 6px 4px;
    background: var(--bordure);
  }
  .titre {
    margin: 0;
    padding: 6px 10px 4px;
    font: 500 10.5px var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--texte-3);
  }
  .etiquettes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 8px 6px;
  }
  .etiq {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--r-1);
    background: var(--surface-3);
    color: var(--texte-2);
    font: 400 11.5px var(--sans);
    cursor: pointer;
  }
  .etiq:hover {
    color: var(--texte);
  }
  .etiq.on {
    background: var(--accent-doux);
    border-color: var(--accent-bord);
    color: var(--texte);
  }
  .etiq:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }
  .option {
    padding: 6px 10px;
  }
  .option :global(.ligne) {
    font-size: 12.5px;
    color: var(--texte-2);
  }
  .pied {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 6px 6px 2px;
  }
</style>
