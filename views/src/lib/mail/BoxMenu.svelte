<script lang="ts">
  import type { LabelView } from '../types.ts';

  interface Props {
    label: string;
    /** Accessible name of the button when it differs from its text (« ✎ »). */
    ariaLabel?: string;
    boxes: LabelView[];
    /** Adds « Corbeille » after the boxes. */
    withTrash?: boolean;
    onpick: (boxId: string) => void;
  }
  let { label, ariaLabel, boxes, withTrash = false, onpick }: Props = $props();
  let open = $state(false);

  function pick(id: string) {
    open = false;
    onpick(id);
  }
</script>

<div class="menu-wrap">
  <button
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={ariaLabel ?? label}
    onclick={() => (open = !open)}>{label}</button
  >
  {#if open}
    <div class="menu" role="menu">
      {#each boxes as box (box.id)}
        <button type="button" role="menuitem" onclick={() => pick(box.id)}>{box.name}</button>
      {/each}
      {#if withTrash}
        <button type="button" role="menuitem" onclick={() => pick('trash')}>Corbeille</button>
      {/if}
      {#if boxes.length === 0 && !withTrash}
        <p class="empty">Aucune boîte : en créer dans les réglages.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .menu-wrap {
    position: relative;
    display: inline-block;
  }
  .menu {
    position: absolute;
    z-index: 5;
    top: calc(100% + 4px);
    left: 0;
    min-width: 11rem;
    display: flex;
    flex-direction: column;
    padding: 0.3rem;
    background: var(--surface-2);
    border: 1px solid var(--bordure);
    border-radius: var(--rayon);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .menu button {
    text-align: left;
    border: 0;
  }
  .menu button:hover {
    background: var(--accent-doux);
  }
  .empty {
    margin: 0.3rem;
    font-size: 0.8rem;
    color: var(--lune);
  }
</style>
