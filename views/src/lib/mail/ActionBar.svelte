<script lang="ts">
  import type { LabelView, MailSummary } from '../types.ts';
  import BoxMenu from './BoxMenu.svelte';
  import { targetName } from './format.ts';

  interface Props {
    mail: MailSummary;
    labels: LabelView[];
    onback: () => void;
    onfile: (boxId: string) => void;
    onvalidate: () => void;
    onarchive: () => void;
    ontrash: () => void;
    onspam: () => void;
    onunread: () => void;
    onreply: () => void;
  }
  let { mail, labels, onback, onfile, onvalidate, onarchive, ontrash, onspam, onunread, onreply }: Props =
    $props();

  const boxes = $derived(labels.filter((l) => l.role === 'box'));
  const pending = $derived(mail.proposal?.status === 'pending' ? mail.proposal : undefined);
  const inTrash = $derived(mail.labels.includes('TRASH'));
</script>

<div class="bar" role="toolbar" aria-label="Actions sur le mail">
  <button type="button" aria-label="Retour à la liste" onclick={onback}>←</button>
  {#if pending}
    <button type="button" class="ok" onclick={onvalidate}>✓ {targetName(pending.boxId, labels)}</button>
  {/if}
  <BoxMenu label="Ranger" {boxes} onpick={onfile} />
  <button type="button" onclick={onarchive}>Archiver</button>
  {#if !inTrash}<button type="button" onclick={ontrash}>Corbeille</button>{/if}
  <button type="button" onclick={onspam}>Spam</button>
  <button type="button" onclick={onunread}>Non lu</button>
  <button type="button" onclick={onreply}>Répondre</button>
</div>

<style>
  .bar {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.75rem;
    background: var(--surface-2);
    border-bottom: 2px solid var(--monde-accent);
  }
  .ok {
    border-color: rgba(70, 140, 100, 0.6);
  }
</style>
