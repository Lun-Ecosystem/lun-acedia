<script lang="ts">
  import { Check, ICON_STROKE } from '../ui/Icon.ts';

  /** The round box of a task (Google Tasks), ticked in place. */

  interface Props {
    title: string;
    done: boolean;
    /** 18 px on the tasks page, 11 px in the band of the agenda. */
    size?: 'petit' | 'normal';
    ontoggle: () => void;
  }
  let { title, done, size = 'normal', ontoggle }: Props = $props();
</script>

<button
  type="button"
  role="checkbox"
  class={['rond', size, { fait: done }]}
  aria-checked={done}
  aria-label={`Cocher ${title}`}
  onclick={(e) => {
    e.stopPropagation();
    ontoggle();
  }}
>
  {#if done && size === 'normal'}<Check size={12} strokeWidth={3} aria-hidden="true" />{/if}
</button>

<style>
  .rond {
    display: grid;
    place-items: center;
    flex: none;
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1.6px solid var(--texte-3);
    border-radius: 50%;
    background: none;
    color: var(--fond);
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
  }
  .rond.petit {
    width: 11px;
    height: 11px;
    border-width: 1.5px;
  }
  .rond:hover {
    border-color: var(--ok);
  }
  .rond.fait {
    background: var(--ok);
    border-color: var(--ok);
  }
  .rond.petit.fait {
    background: var(--texte-3);
    border-color: var(--texte-3);
  }
  .rond:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }
  /* A larger target than the drawn box, for a finger. */
  .rond {
    position: relative;
  }
  .rond::after {
    content: '';
    position: absolute;
    inset: -8px;
  }
</style>
