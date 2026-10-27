<script lang="ts">
  import { ICON_STROKE, Sparkles } from '../ui/Icon.ts';
  import Kbd from '../ui/Kbd.svelte';

  /** The only fixed element of the bottom-right corner (plate 01, state 1); the badge counts the pending cards. */

  interface Props {
    pending: number;
    onclick: () => void;
    element?: HTMLButtonElement | null | undefined;
  }

  let { pending, onclick, element = $bindable(null) }: Props = $props();
</script>

<button
  bind:this={element}
  type="button"
  class="lanceur"
  aria-keyshortcuts="Control+J"
  aria-expanded="false"
  {onclick}
>
  <Sparkles size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
  Pina
  <Kbd>Ctrl J</Kbd>
  {#if pending > 0}
    <span class="pt" aria-hidden="true">{pending}</span><span class="sr">, {pending} en attente</span>
  {/if}
</button>

<style>
  .lanceur {
    position: fixed;
    right: 22px;
    bottom: 22px;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 44px;
    padding: 0 16px 0 14px;
    border: 1px solid var(--ia-bord);
    border-radius: 22px;
    background: var(--surface-2);
    box-shadow: var(--ombre-2);
    color: var(--texte);
    font: 400 13.5px var(--sans);
    cursor: pointer;
  }
  .lanceur :global(svg) {
    color: var(--ia);
  }
  .lanceur :global(.kbd) {
    margin-left: 4px;
  }
  .lanceur:hover {
    background: var(--surface-3);
  }
  .lanceur:focus-visible {
    outline: 2px solid var(--ia);
    outline-offset: 2px;
  }
  .pt {
    position: absolute;
    top: -3px;
    right: -3px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--ia);
    color: var(--encre-2);
    font: 500 10.5px/18px var(--sans);
    text-align: center;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 767.98px) {
    .lanceur {
      display: none;
    }
  }
</style>
