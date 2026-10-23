<script lang="ts">
  import type { LabelView, MailSummary } from '../types.ts';
  import AutoMark from '../ui/AutoMark.svelte';
  import Badge from '../ui/Badge.svelte';
  import Checkbox from '../ui/Checkbox.svelte';
  import { Archive, Folder, Trash } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import ListRow from '../ui/ListRow.svelte';
  import ProposalChip from '../ui/ProposalChip.svelte';
  import Avatar from './Avatar.svelte';
  import { sender, targetName, time } from './format.ts';

  /*
   * One mail of the list. Wide: box, unread dot, avatar, sender, what the AI proposed or did, time,
   * then subject and start of the message on one line. Compact (a mail is open, or a phone): the AI
   * goes under the text. Archive, file and trash appear on hover.
   */

  interface Props {
    mail: MailSummary;
    labels: LabelView[];
    checked: boolean;
    /** The mail is open in the reading pane. */
    active: boolean;
    compact: boolean;
    onopen: () => void;
    ontoggle: () => void;
    onvalidate: () => void;
    /** Opens « Ranger dans » from the element given. */
    onfile: (anchor: HTMLElement) => void;
    onarchive: () => void;
    ontrash: () => void;
  }
  let {
    mail,
    labels,
    checked,
    active,
    compact,
    onopen,
    ontoggle,
    onvalidate,
    onfile,
    onarchive,
    ontrash,
  }: Props = $props();

  const tags = $derived(labels.filter((l) => l.role === 'tag' && mail.labels.includes(l.id)));
  const proposal = $derived(mail.proposal);
  const proposedTags = $derived(
    proposal?.status === 'pending'
      ? labels.filter((l) => proposal.tagIds.includes(l.id) && !mail.labels.includes(l.id)).map((l) => l.name)
      : [],
  );
  const name = $derived(sender(mail.from));
</script>

<!-- The compact list (a mail open) keeps these actions in the reading toolbar. -->
{#snippet hover()}
  <IconButton icon={Archive} label="Archiver" shortcut="E" size="petit" onclick={onarchive} />
  <IconButton
    icon={Folder}
    label="Ranger dans"
    size="petit"
    aria-haspopup="menu"
    onclick={(event) => onfile(event.currentTarget)}
  />
  <IconButton icon={Trash} label="Corbeille" shortcut="#" size="petit" onclick={ontrash} />
{/snippet}

<li>
  <ListRow
    id="mail-{mail.id}"
    tabindex={-1}
    selected={active || checked}
    read={!mail.unread}
    {onopen}
    onkeydown={(event) => {
      if (event.key === 'Enter' && event.target === event.currentTarget) onopen();
    }}
    class={['mail', { compact }]}
    actions={compact ? undefined : hover}
  >
    {#snippet start()}
      {#if !compact}
        <span class="case"><Checkbox aria-label="Sélectionner" {checked} onchange={() => ontoggle()} /></span>
        <span class={['point', { on: mail.unread }]}
          ><span class="sr">{mail.unread ? 'Non lu' : ''}</span></span
        >
      {/if}
      <Avatar {name} />
    {/snippet}
    <div class="grille">
      <span class="de">{name}</span>
      <span class="marques">
        {#each tags as tag (tag.id)}
          <Badge tone={tag.name.toLowerCase() === 'urgent' ? 'attention' : 'neutre'}>{tag.name}</Badge>
        {/each}
        {#if proposal?.status === 'pending'}
          <ProposalChip
            {proposal}
            boxName={targetName(proposal.boxId, labels)}
            tagNames={proposedTags}
            {onvalidate}
            oncorrect={onfile}
          />
        {:else if proposal?.status === 'auto' && proposal.boxId}
          <AutoMark boxName={targetName(proposal.boxId, labels)} />
        {/if}
      </span>
      <span class="heure">{time(mail.date)}</span>
      <span class="texte"
        ><b class="objet">{mail.subject || '(sans objet)'}</b><span class="apercu"
          >{#if mail.snippet}<span class="sep" aria-hidden="true">{' · '}</span>{mail.snippet}{/if}</span
        ></span
      >
    </div>
  </ListRow>
</li>

<style>
  li {
    list-style: none;
  }
  .case {
    display: contents;
  }
  .point {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .point.on {
    background: var(--accent-texte);
  }
  .grille {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    grid-template-areas:
      'de marques . heure'
      'texte texte texte texte';
    align-items: center;
    column-gap: 8px;
    row-gap: 1px;
  }
  .de {
    grid-area: de;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    font-size: 13.5px;
    color: var(--texte);
  }
  .marques {
    grid-area: marques;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .heure {
    grid-area: heure;
    color: var(--texte-3);
    font-size: 12px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .texte {
    grid-area: texte;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--texte-2);
  }
  .objet {
    font-weight: 400;
    color: var(--texte);
  }
  /* Read: lighter sender and subject. */
  :global(.lu) .de,
  :global(.lu) .objet {
    font-weight: 300;
    color: var(--texte-2);
  }
  :global(.compact) .grille {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'de heure'
      'texte texte'
      'marques marques';
  }
  :global(.compact) .marques {
    margin-top: 4px;
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
    /* Phone: no ticking nor dot, as on plate 03; the selection stays a desktop gesture. */
    .case,
    .point {
      display: none;
    }
    .grille {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        'de heure'
        'texte texte'
        'marques marques';
    }
    .marques {
      margin-top: 6px;
    }
    .texte {
      white-space: normal;
    }
    .objet {
      display: block;
    }
    .apercu {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sep {
      display: none;
    }
  }
</style>
