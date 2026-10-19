<script lang="ts">
  import type { LabelView, MailSummary } from '../types.ts';
  import BoxMenu from './BoxMenu.svelte';
  import { sender, shortDate, targetName } from './format.ts';

  interface Props {
    mail: MailSummary;
    labels: LabelView[];
    checked: boolean;
    active: boolean;
    onopen: () => void;
    ontoggle: () => void;
    onvalidate: () => void;
    oncorrect: (boxId: string) => void;
  }
  let { mail, labels, checked, active, onopen, ontoggle, onvalidate, oncorrect }: Props = $props();

  const boxes = $derived(labels.filter((l) => l.role === 'box'));
  const tags = $derived(labels.filter((l) => l.role === 'tag' && mail.labels.includes(l.id)));
  const pending = $derived(mail.proposal?.status === 'pending' ? mail.proposal : undefined);
  const proposedTags = $derived(
    pending ? labels.filter((l) => pending.tagIds.includes(l.id) && !mail.labels.includes(l.id)) : [],
  );
</script>

<li class="row" class:unread={mail.unread} class:active>
  <input type="checkbox" aria-label="Sélectionner" {checked} onchange={ontoggle} />
  <button type="button" class="open" onclick={onopen}>
    <span class="from">{sender(mail.from)}</span>
    <span class="subject">{mail.subject}</span>
    <span class="snippet">{mail.snippet}</span>
    {#each tags as tag (tag.id)}
      <span class="chip" class:urgent={tag.name.toLowerCase() === 'urgent'}>{tag.name}</span>
    {/each}
    <span class="date">{shortDate(mail.date)}</span>
  </button>
  {#if pending}
    <div class="proposal">
      <span class="chip proposed">{targetName(pending.boxId, labels)} ?</span>
      {#each proposedTags as tag (tag.id)}
        <span class="chip" class:urgent={tag.name.toLowerCase() === 'urgent'}>{tag.name}</span>
      {/each}
      <span class="confidence">{pending.confidence} %</span>
      <button type="button" class="ok" aria-label="Valider la proposition" onclick={onvalidate}>✓</button>
      <BoxMenu label="✎" ariaLabel="Corriger" {boxes} withTrash onpick={oncorrect} />
    </div>
  {/if}
</li>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.75rem;
    border-bottom: 1px solid var(--bordure);
  }
  .row.active {
    background: var(--accent-doux);
  }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    border: 0;
    padding: 0.2rem 0;
    text-align: left;
  }
  .from {
    flex: 0 0 9.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .subject {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .snippet {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--lune);
    opacity: 0.75;
  }
  .unread .from,
  .unread .subject {
    font-weight: 500;
  }
  .date {
    flex: none;
    font-size: 0.8rem;
    color: var(--lune);
  }
  .proposal {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .chip {
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    background: var(--accent-doux);
    white-space: nowrap;
  }
  .chip.urgent {
    background: rgba(122, 24, 24, 0.55);
  }
  .chip.proposed {
    border: 1px dashed var(--monde-accent);
  }
  .confidence {
    font-size: 0.75rem;
    color: var(--lune);
  }
  .ok {
    border-color: rgba(70, 140, 100, 0.6);
  }
  @media (max-width: 899px) {
    .from {
      flex-basis: 100%;
    }
    .open {
      flex-wrap: wrap;
    }
    .snippet {
      flex-basis: 100%;
    }
  }
</style>
