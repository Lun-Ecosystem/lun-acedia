<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import type { AttachmentMeta, LabelView, MailDetail, MailSummary } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import { Archive, ArrowLeft, Ban, Ellipsis, Eye, FileText, Folder, Reply, Trash } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import Kbd from '../ui/Kbd.svelte';
  import Menu from '../ui/Menu.svelte';
  import ProposalCard from '../ui/ProposalCard.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import ActionBar from './ActionBar.svelte';
  import Avatar from './Avatar.svelte';
  import { ago, errorText, longDate, sender, targetName } from './format.ts';
  import MailFrame from './MailFrame.svelte';

  interface Props {
    client: AcediaClient;
    mail: MailSummary;
    detail: MailDetail | null;
    labels: LabelView[];
    /** Auto-sort threshold, in %. */
    threshold: number;
    /** « 1 sur 12 ». */
    position: string;
    onback: () => void;
    onfile: (anchor: HTMLElement) => void;
    onvalidate: () => void;
    onarchive: () => void;
    ontrash: () => void;
    onspam: () => void;
    onunread: () => void;
    onreply: () => void;
    onerror: (message: string) => void;
  }
  let { client, mail, detail, labels, threshold, position, onerror, ...on }: Props = $props();

  const from = $derived(detail?.from ?? mail.from);
  const name = $derived(sender(from));
  const pending = $derived(mail.proposal?.status === 'pending' ? mail.proposal : undefined);
  const inTrash = $derived(mail.labels.includes('TRASH'));

  async function download(a: AttachmentMeta) {
    try {
      const url = URL.createObjectURL(await client.attachment(mail.id, a.id));
      const link = document.createElement('a');
      link.href = url;
      link.download = a.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      onerror(errorText(err));
    }
  }

  const size = (bytes: number) =>
    bytes > 1_000_000
      ? `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} Mo`
      : `${Math.max(1, Math.round(bytes / 1000))} Ko`;
  const kind = (a: AttachmentMeta) => (a.filename.split('.').pop() ?? a.mimeType).toUpperCase();
</script>

<section class="lecture" aria-label="Lecture">
  <div class="bureau">
    <ActionBar {inTrash} {position} {...on} />
  </div>
  <div class="haut-mobile">
    <IconButton icon={ArrowLeft} label="Retour à la liste" onclick={on.onback} />
    <span class="outils">
      <IconButton icon={Archive} label="Archiver" onclick={on.onarchive} />
      {#if !inTrash}<IconButton icon={Trash} label="Corbeille" onclick={on.ontrash} />{/if}
      <Menu
        label="Plus d’actions"
        sections={[
          {
            items: [
              { id: 'spam', label: 'Signaler comme spam', icon: Ban, onselect: on.onspam },
              { id: 'unread', label: 'Marquer non lu', icon: Eye, onselect: on.onunread },
            ],
          },
        ]}
        align="end"
      >
        {#snippet trigger({ props })}
          <IconButton {...props} icon={Ellipsis} label="Plus d’actions" />
        {/snippet}
      </Menu>
    </span>
  </div>

  <div class="contenu">
    <h2 class="objet">{mail.subject || '(sans objet)'}</h2>
    <div class="exp">
      <Avatar {name} size={38} />
      <div class="qui">
        <b>{name}</b> <span class="adresse">&lt;{from.addr}&gt;</span>
        {#if detail}<span class="a"
            >À {detail.to}{#if detail.cc}, Cc {detail.cc}{/if}</span
          >{/if}
      </div>
      <div class="quand">
        <time datetime={mail.date}>{longDate(mail.date)}</time>
        {#if ago(mail.date)}<span>{ago(mail.date)}</span>{/if}
      </div>
    </div>
    {#if pending && pending.boxId !== null}
      <ProposalCard
        class="carte"
        proposal={pending}
        boxName={targetName(pending.boxId, labels)}
        reason={pending.reason}
        {threshold}
        onvalidate={on.onvalidate}
        oncorrect={on.onfile}
      />
    {/if}
    {#if detail}
      <MailFrame html={detail.html} />
    {:else}
      <div class="chargement" aria-busy="true">
        <Skeleton width="80%" /><Skeleton width="65%" /><Skeleton width="72%" />
      </div>
    {/if}
    {#if detail?.attachments.length}
      <ul class="pieces" aria-label="Pièces jointes">
        {#each detail.attachments as a (a.id)}
          <li>
            <button type="button" class="piece" onclick={() => download(a)}>
              <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{a.filename}<small>{kind(a)} · {size(a.size)}</small></span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <button type="button" class="repondre" onclick={on.onreply}>
      <Reply size={16} strokeWidth={1.75} aria-hidden="true" />Répondre à {name}…<Kbd>R</Kbd>
    </button>
  </div>

  <div class="bas-mobile">
    <Button variant="fantome" icon={Reply} onclick={on.onreply}>Répondre</Button>
    <Button
      variant="fantome"
      icon={Folder}
      aria-haspopup="menu"
      onclick={(event) => on.onfile(event.currentTarget)}>Ranger</Button
    >
  </div>
</section>

<style>
  .lecture {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--fond);
  }
  .haut-mobile,
  .bas-mobile {
    display: none;
  }
  .contenu {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    padding: 22px 34px 24px;
  }
  .objet {
    margin: 0 0 14px;
    font: 500 28px/1.2 var(--serif);
    overflow-wrap: anywhere;
  }
  .exp {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
    font-size: 13.5px;
  }
  .qui {
    min-width: 0;
  }
  .qui b {
    font-weight: 500;
  }
  .adresse,
  .a,
  .quand {
    color: var(--texte-3);
    font-size: 12.5px;
  }
  .a {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quand {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    margin-left: auto;
  }
  .contenu :global(.carte) {
    flex: none;
    max-width: 720px;
    margin-bottom: 20px;
  }
  .chargement {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    max-width: 720px;
  }
  .pieces {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
  }
  .piece {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--surface-1);
    border: 1px solid var(--bordure);
    border-radius: var(--r-2);
    color: var(--texte);
    font: 300 13px/1.4 var(--sans);
    text-align: left;
    cursor: pointer;
  }
  .piece:hover {
    border-color: var(--bordure-forte);
  }
  .piece :global(svg) {
    flex: none;
    color: var(--danger);
  }
  .piece small {
    display: block;
    color: var(--texte-3);
    font-size: 11.5px;
  }
  .repondre {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    max-width: 720px;
    height: 44px;
    margin-top: 16px;
    padding: 0 14px;
    background: var(--surface-1);
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
    color: var(--texte-3);
    font: 300 13.5px var(--sans);
    text-align: left;
    cursor: text;
  }
  .repondre:hover {
    border-color: var(--accent-bord);
  }
  .repondre :global(.kbd) {
    margin-left: auto;
  }
  .piece:focus-visible,
  .repondre:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }

  /* Phone: the reading is a screen of its own, above the list and the bottom bar. */
  @media (max-width: 767.98px) {
    .lecture {
      position: fixed;
      inset: 0;
      z-index: 45;
    }
    .bureau,
    .repondre {
      display: none;
    }
    .haut-mobile {
      display: flex;
      justify-content: space-between;
      padding: max(6px, env(safe-area-inset-top)) 14px 6px;
    }
    .outils {
      display: flex;
      gap: 2px;
    }
    .contenu {
      padding: 4px 18px 12px;
    }
    .objet {
      font-size: 25px;
    }
    .adresse,
    .quand span {
      display: none;
    }
    .bas-mobile {
      display: flex;
      justify-content: space-around;
      align-items: center;
      height: calc(60px + env(safe-area-inset-bottom, 0px));
      padding-bottom: env(safe-area-inset-bottom, 0px);
      background: var(--surface-1);
      border-top: 1px solid var(--bordure);
    }
  }
</style>
