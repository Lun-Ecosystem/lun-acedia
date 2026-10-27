<script lang="ts">
  import type { PinaCard } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import { Pencil } from '../ui/Icon.ts';
  import ActionCard from './ActionCard.svelte';
  import type { CardText } from './cards.ts';

  /*
   * A draft Pina prepared (plate 01, state 3): never sent from here. « Ouvrir le brouillon » leads to
   * the composer, where sending is CrOliX's own click.
   */

  interface Props {
    card: PinaCard;
    text: CardText;
    busy?: boolean | undefined;
    readonly?: boolean | undefined;
    onaccept: (input?: unknown) => void;
    onrefuse: () => void;
    onundo: () => void;
    onopen: (draftId: string) => void;
    /** Puts a request to rewrite the draft in Pina's field. */
    onrephrase: () => void;
  }

  let { card, text, busy, readonly, onaccept, onrefuse, onundo, onopen, onrephrase }: Props = $props();

  const input = $derived(
    (card.input ?? {}) as { id?: string; to?: string; cc?: string; subject?: string; text?: string },
  );
  /** The draft an update replaces, as the card text names it. */
  const replaces = $derived(
    card.action === 'draft.update' ? text.fields.find((f) => f.key === undefined) : undefined,
  );
  /** The Gmail draft: `draft.create` answers it, `draft.update` names it. */
  /** « Camille Durand », without the address, as the mockup names the recipient. */
  const to = $derived((input.to ?? '').replace(/\s*<[^>]*>/g, '').trim() || (input.to ?? ''));
  const draftId = $derived((card.result as { id?: string } | null)?.id ?? input.id);
</script>

{#snippet preview()}
  <div class="brouillon">
    {#if replaces}<div class="a">
        Remplace {replaces.label === 'Identifiant'
          ? `l’identifiant ${replaces.value}`
          : `“${replaces.value}”`}
      </div>{/if}
    <div class="a">
      À {to}{input.cc ? ` · Copie ${input.cc}` : ''}{input.subject ? ` · ${input.subject}` : ''}
    </div>
    <p>{(input.text ?? '').replace(/\s+/g, ' ')}</p>
  </div>
{/snippet}

{#snippet doneActions()}
  {#if draftId}
    <Button variant="doux" size="petit" icon={Pencil} onclick={() => onopen(draftId)}
      >Ouvrir le brouillon</Button
    >
  {/if}
  {#if !readonly}
    <Button variant="fantome" size="petit" onclick={onrephrase}>Reformuler</Button>
  {/if}
{/snippet}

<ActionCard
  {card}
  {text}
  {busy}
  {readonly}
  {onaccept}
  {onrefuse}
  {onundo}
  {preview}
  {doneActions}
  undoLabel="Jeter"
  onedit={card.action === 'draft.update' && draftId ? () => onopen(draftId) : undefined}
/>

<style>
  .brouillon {
    margin-bottom: 10px;
    padding: 9px 11px;
    border: 1px solid var(--bordure);
    border-radius: var(--r-1);
    background: var(--fond);
    font-size: 13px;
    line-height: 1.55;
    color: var(--papier);
  }
  .a {
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--texte-3);
  }
  p {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    line-clamp: 3;
  }
</style>
