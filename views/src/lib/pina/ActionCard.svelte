<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PinaCard } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import { Check, CircleAlert, Clock, ICON_STROKE, Pencil, Undo, X } from '../ui/Icon.ts';
  import Kbd from '../ui/Kbd.svelte';
  import { bindShortcuts } from '../ui/shortcuts.ts';
  import TextInput from '../ui/TextInput.svelte';
  import { timeLabel, type CardText } from './cards.ts';

  /*
   * One card of Pina's thread (plate 01, state 2). Pending: its readable fields and Valider, Modifier,
   * Refuser; Ctrl Enter and Escape decide it while it has the focus. Done: one line, with Annuler when
   * the server keeps an inverse. Refused, failed (with the server's reason) and expired: one line.
   */

  interface Props {
    card: PinaCard;
    text: CardText;
    busy?: boolean | undefined;
    /** A past day: shown, never decided. */
    readonly?: boolean | undefined;
    onaccept: (input?: unknown) => void;
    onrefuse: () => void;
    onundo: () => void;
    /** Shown under the title (the draft's preview), in place of the fields. */
    preview?: Snippet | undefined;
    /** Actions of a done card, before Annuler (« Ouvrir le brouillon »). */
    doneActions?: Snippet | undefined;
    /** Replaces the inline fields of « Modifier » (a draft opens in the composer). */
    onedit?: (() => void) | undefined;
    /** Label of the undo of a done card. */
    undoLabel?: string | undefined;
  }

  let {
    card,
    text,
    busy = false,
    readonly = false,
    onaccept,
    onrefuse,
    onundo,
    preview,
    doneActions,
    onedit,
    undoLabel = 'Annuler',
  }: Props = $props();

  let editing = $state<Record<string, string> | null>(null);
  const editable = $derived(text.fields.filter((f) => f.key));

  function startEdit() {
    if (onedit) return onedit();
    const input = (card.input ?? {}) as Record<string, unknown>;
    editing = Object.fromEntries(editable.map((f) => [f.key!, String(input[f.key!] ?? '')]));
  }

  function accept() {
    if (busy) return;
    onaccept(editing ? { ...(card.input as object), ...editing } : undefined);
  }

  const shortcuts = (node: HTMLElement) =>
    bindShortcuts({ 'Ctrl+Enter': accept, Escape: () => !busy && onrefuse() }, node);
</script>

{#if card.status === 'pending'}
  <!-- The card takes the focus so that Ctrl Enter and Escape decide it. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="carte"
    role="group"
    tabindex={readonly ? undefined : 0}
    aria-label={`${text.title}, en attente`}
    aria-busy={busy || undefined}
    {@attach readonly ? undefined : shortcuts}
  >
    <div class="t">
      <text.icon size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />{text.title}
      <span class="etat-c">{readonly ? 'restée en attente' : 'en attente'}</span>
    </div>
    {#if preview}
      {@render preview()}
    {/if}
    {#if editing}
      <div class="edition">
        {#each editable as f (f.key)}
          <label>
            <span>{f.label}</span>
            <TextInput size="petit" bind:value={editing[f.key!]} />
          </label>
        {/each}
      </div>
    {:else if !preview && text.fields.length}
      <dl class="champ">
        {#each text.fields as f (f.label)}<dt>{f.label}</dt>
          <dd>{f.value}</dd>{/each}
      </dl>
    {/if}
    {#if !readonly}
      <div class="act">
        <Button variant="doux" size="petit" icon={Check} loading={busy} onclick={accept}>Valider</Button>
        {#if editing}
          <Button variant="fantome" size="petit" onclick={() => (editing = null)}
            >Garder la proposition</Button
          >
        {:else if editable.length || onedit}
          <Button variant="secondaire" size="petit" icon={Pencil} onclick={startEdit}>Modifier</Button>
        {/if}
        <Button variant="fantome" size="petit" disabled={busy} onclick={onrefuse}>Refuser</Button>
        <span class="touche"><Kbd>Ctrl ↵</Kbd></span>
      </div>
    {/if}
  </div>
{:else if card.status === 'done'}
  <div class={['carte', { faite: !preview }]} role="group" aria-label={`${text.done}, fait`}>
    {#if preview}
      <div class="t">
        <text.icon size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />{text.title}
        <span class="etat-c">prêt, non envoyé</span>
      </div>
      {@render preview()}
      <div class="act">
        {@render doneActions?.()}
        {#if card.inverse && !readonly}
          <Button variant="fantome" size="petit" loading={busy} onclick={onundo}>{undoLabel}</Button>
        {/if}
      </div>
    {:else}
      <div class="ligne">
        <Check size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span class="quoi">{text.done}{card.decidedAt ? ` · ${timeLabel(card.decidedAt)}` : ''}</span>
        {#if card.inverse && !readonly}
          <Button variant="fantome" size="petit" class="annuler" icon={Undo} loading={busy} onclick={onundo}
            >{undoLabel}</Button
          >
        {/if}
      </div>
    {/if}
  </div>
{:else}
  {@const failed = card.status === 'failed'}
  <div class={['carte', 'close', { echec: failed }]} role="group" aria-label={text.title}>
    <div class="ligne">
      {#if failed}
        <CircleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      {:else if card.status === 'expired'}
        <Clock size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      {:else}
        <X size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      {/if}
      <span class="quoi">{text.title}</span>
      <span class="etat-c"
        >{failed ? 'échec' : card.status === 'expired' ? 'expirée, rien n’a été fait' : 'refusée'}</span
      >
    </div>
    {#if failed && card.error}<p class="raison">{card.error}</p>{/if}
  </div>
{/if}

<style>
  .carte {
    padding: 11px 12px;
    border: 1px solid var(--ia-bord);
    border-radius: var(--r-2);
    background: linear-gradient(180deg, var(--ia-doux), transparent);
  }
  .carte:focus-visible {
    outline: 2px solid var(--ia);
    outline-offset: 2px;
  }
  .t {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 7px;
    color: var(--ia);
    font-size: 12px;
  }
  .etat-c {
    margin-left: auto;
    color: var(--texte-3);
  }
  .champ {
    display: grid;
    grid-template-columns: 78px minmax(0, 1fr);
    gap: 4px 10px;
    margin: 0 0 10px;
    font-size: 13px;
  }
  .champ dt {
    color: var(--texte-3);
  }
  .champ dd {
    margin: 0;
    color: var(--texte);
    overflow-wrap: anywhere;
  }
  .edition {
    display: grid;
    gap: 6px;
    margin-bottom: 10px;
  }
  .edition label {
    display: grid;
    grid-template-columns: 78px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--texte-3);
  }
  .act {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .touche {
    margin-left: auto;
  }
  @media (max-width: 767.98px) {
    .touche {
      display: none;
    }
  }
  .faite {
    border-color: var(--ok-bord);
    background: var(--ok-doux);
  }
  .ligne {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 24px;
    font-size: 12px;
  }
  .faite .ligne,
  .faite .t {
    color: var(--ok);
  }
  .faite .t {
    margin-bottom: 7px;
  }
  .quoi {
    min-width: 0;
  }
  .ligne :global(.annuler) {
    height: 24px;
    margin-left: auto;
  }
  .close {
    border-color: var(--bordure);
    background: var(--surface-1);
    color: var(--texte-3);
  }
  .close .quoi {
    color: var(--texte-2);
  }
  .echec {
    border-color: var(--danger-bord);
    background: var(--danger-doux);
  }
  .echec .ligne {
    color: var(--danger);
  }
  .raison {
    margin: 6px 0 0 21px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--texte-2);
  }
</style>
