<script lang="ts">
  import type { SvelteSet } from 'svelte/reactivity';
  import type { LabelView, MailSummary } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import DayGroup from '../ui/DayGroup.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import { Inbox } from '../ui/Icon.ts';
  import Skeleton from '../ui/Skeleton.svelte';
  import { dayLabel } from './format.ts';
  import MailRow from './MailRow.svelte';

  /** The mails, grouped by day, newest first as the server gives them. */

  interface Props {
    items: MailSummary[];
    labels: LabelView[];
    selected: SvelteSet<string>;
    openId: string | null;
    /** The row Tab reaches: the open or current mail, else the first. */
    focusId: string | null;
    compact: boolean;
    loading: boolean;
    hasMore: boolean;
    /** What the empty list says (« Aucun mail ici. », « Aucun résultat pour … »). */
    empty: string;
    onopen: (m: MailSummary) => void;
    onvalidate: (m: MailSummary) => void;
    onfile: (m: MailSummary, anchor: HTMLElement) => void;
    onarchive: (m: MailSummary) => void;
    ontrash: (m: MailSummary) => void;
    onmore: () => void;
    onmove: (step: number) => void;
    onfocus: (m: MailSummary) => void;
  }
  let { items, labels, selected, openId, focusId, compact, loading, hasMore, empty, onmore, ...on }: Props =
    $props();

  const days = $derived.by(() => {
    const groups: { label: string; mails: MailSummary[] }[] = [];
    for (const mail of items) {
      const label = dayLabel(mail.date);
      const last = groups.at(-1);
      if (last?.label === label) last.mails.push(mail);
      else groups.push({ label, mails: [mail] });
    }
    return groups;
  });

  function toggle(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
</script>

<div class="mails" role="group" aria-label="Mails" aria-busy={loading}>
  {#if loading && items.length === 0}
    {#each [1, 2, 3, 4, 5] as n (n)}
      <div class="fantome">
        <Skeleton shape="rond" />
        <div class="lignes"><Skeleton width="30%" /><Skeleton width="{90 - n * 8}%" /></div>
      </div>
    {/each}
  {:else if items.length === 0}
    <EmptyState title={empty} icon={Inbox} tone="neutre" />
  {/if}
  {#each days as day (day.label)}
    <DayGroup label={day.label}>
      <ul>
        {#each day.mails as mail (mail.id)}
          <MailRow
            {mail}
            {labels}
            {compact}
            checked={selected.has(mail.id)}
            active={mail.id === openId}
            tabbable={mail.id === (focusId ?? items[0]?.id)}
            onmove={on.onmove}
            onfocus={() => on.onfocus(mail)}
            onopen={() => on.onopen(mail)}
            ontoggle={() => toggle(mail.id)}
            onvalidate={() => on.onvalidate(mail)}
            onfile={(anchor) => on.onfile(mail, anchor)}
            onarchive={() => on.onarchive(mail)}
            ontrash={() => on.ontrash(mail)}
          />
        {/each}
      </ul>
    </DayGroup>
  {/each}
  {#if hasMore}
    <div class="plus">
      <Button variant="fantome" size="petit" onclick={onmore}>Mails plus anciens</Button>
    </div>
  {/if}
</div>

<style>
  ul {
    margin: 0;
    padding: 0;
  }
  .fantome {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 60px;
    padding: 8px 18px;
    border-bottom: 1px solid var(--bordure);
  }
  .lignes {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
  }
  .mails > :global(.vide) {
    margin: 48px auto;
  }
  .plus {
    display: flex;
    justify-content: center;
    padding: 12px;
  }
</style>
