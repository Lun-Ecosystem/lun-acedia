<script lang="ts">
  import type { PinaCard, PinaThread } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import { Check, Settings } from '../ui/Icon.ts';
  import ActionCard from './ActionCard.svelte';
  import { describe, type Names } from './cards.ts';
  import DraftCard from './DraftCard.svelte';
  import type { PinaState } from './pina.svelte.ts';

  /*
   * A day of the thread, in order: CrOliX's requests, Pina's replies, and after each reply the cards
   * of its tool calls. Reads and tool results stay out of sight. Several pending cards of one turn get
   * « Tout valider ».
   */

  interface Props {
    thread: PinaThread;
    pina: PinaState;
    names: Names;
    readonly?: boolean | undefined;
    onopendraft: (id: string) => void;
    onrephrase: () => void;
    onsettings: () => void;
    /** A decision is over: the focus moves on. */
    onsettled: () => void;
  }

  let {
    thread,
    pina,
    names,
    readonly = false,
    onopendraft,
    onrephrase,
    onsettings,
    onsettled,
  }: Props = $props();

  type Item =
    | { kind: 'moi'; id: number; text: string }
    | { kind: 'ia'; id: number; text: string }
    | { kind: 'cartes'; id: number; cards: PinaCard[] };

  const items = $derived.by((): Item[] => {
    const out: Item[] = [];
    const placed = new Set<number>();
    for (const { id, message: m } of thread.messages) {
      if (m.role === 'user') out.push({ kind: 'moi', id, text: m.text });
      if (m.role !== 'assistant') continue;
      if (m.text.trim()) out.push({ kind: 'ia', id, text: m.text });
      const calls = new Set(m.toolCalls.map((c) => c.id));
      const cards = thread.cards.filter((c) => !placed.has(c.id) && c.turn === m.turn && calls.has(c.callId));
      cards.forEach((c) => placed.add(c.id));
      if (cards.length) out.push({ kind: 'cartes', id: -id, cards });
    }
    // Never lost: a card whose message is missing comes last.
    const rest = thread.cards.filter((c) => !placed.has(c.id));
    if (rest.length) out.push({ kind: 'cartes', id: 0, cards: rest });
    return out;
  });

  const isDraft = (c: PinaCard) => c.action === 'draft.create' || c.action === 'draft.update';
</script>

{#each items as item (item.kind + item.id)}
  {#if item.kind === 'moi'}
    <div class="bulle moi">{item.text}</div>
  {:else if item.kind === 'ia'}
    <div class="bulle ia">
      {item.text}
      {#if !readonly && item.text.includes('Réglages ›')}
        <div class="suite">
          <Button variant="fantome" size="petit" icon={Settings} onclick={onsettings}
            >Ouvrir les Réglages</Button
          >
        </div>
      {/if}
    </div>
  {:else}
    {@const waiting = item.cards.filter((c) => c.status === 'pending' && c.effect !== 'delete')}
    {#each item.cards as card (card.id)}
      {@const common = {
        card,
        text: describe(card, names),
        busy: pina.busy.has(card.id),
        readonly,
        onaccept: (input?: unknown) => pina.decide(card.id, 'accept', input).then(onsettled),
        onrefuse: () => pina.decide(card.id, 'refuse').then(onsettled),
        onundo: () => pina.undo(card.id),
      }}
      {#if isDraft(card)}
        <DraftCard {...common} onopen={onopendraft} {onrephrase} />
      {:else}
        <ActionCard {...common} />
      {/if}
    {/each}
    {#if !readonly && waiting.length > 1}
      <div class="groupe">
        <Button
          variant="doux"
          size="petit"
          icon={Check}
          loading={pina.acceptingAll}
          onclick={() => pina.acceptAll(waiting).then(onsettled)}>Tout valider</Button
        >
        <span>{waiting.length} actions proposées ensemble</span>
      </div>
    {/if}
  {/if}
{/each}

<style>
  .bulle {
    max-width: 86%;
    padding: 9px 12px;
    border-radius: 12px;
    font-size: 13.5px;
    line-height: 1.5;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .moi {
    align-self: flex-end;
    border: 1px solid var(--accent-bord);
    border-bottom-right-radius: 4px;
    background: var(--accent-doux);
  }
  .ia {
    align-self: flex-start;
    border: 1px solid var(--bordure);
    border-bottom-left-radius: 4px;
    background: var(--surface-2);
    color: var(--papier);
  }
  .suite {
    margin: 6px 0 -2px -6px;
    white-space: normal;
  }
  .groupe {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--texte-3);
  }
</style>
