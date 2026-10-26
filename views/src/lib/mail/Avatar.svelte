<script lang="ts">
  import { initials, toneOf } from './format.ts';

  /** Initials of a sender, in one of the shared tones (stable for a sender). */
  let { name, size = 30 }: { name: string; size?: number } = $props();
</script>

<span class="avatar t{toneOf(name)}" style:--taille="{size}px" aria-hidden="true">{initials(name)}</span>

<style>
  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: var(--taille);
    height: var(--taille);
    border-radius: 50%;
    font: 500 calc(var(--taille) * 0.38) / 1 var(--sans);
  }
  .t0 {
    background: var(--accent-doux);
    color: var(--accent-texte);
  }
  .t1 {
    background: var(--attention-doux);
    color: var(--attention);
  }
  .t2 {
    background: var(--ok-doux);
    color: var(--ok);
  }
  .t3 {
    background: var(--ia-doux);
    color: var(--ia);
  }
  .t4 {
    background: var(--surface-3);
    color: var(--texte-2);
  }
</style>
