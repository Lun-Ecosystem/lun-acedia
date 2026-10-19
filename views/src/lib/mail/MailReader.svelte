<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import type { AttachmentMeta, LabelView, MailDetail, MailSummary } from '../types.ts';
  import ActionBar from './ActionBar.svelte';
  import { errorText, longDate, sender } from './format.ts';
  import MailFrame from './MailFrame.svelte';

  interface Props {
    client: AcediaClient;
    mail: MailSummary;
    detail: MailDetail | null;
    labels: LabelView[];
    onback: () => void;
    onfile: (boxId: string) => void;
    onvalidate: () => void;
    onarchive: () => void;
    ontrash: () => void;
    onspam: () => void;
    onunread: () => void;
    onreply: () => void;
    onerror: (message: string) => void;
  }
  let { client, mail, detail, labels, onerror, ...actions }: Props = $props();

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
      ? `${(bytes / 1_000_000).toFixed(1)} Mo`
      : `${Math.max(1, Math.round(bytes / 1000))} ko`;
</script>

<section class="reader" aria-label="Lecture">
  <ActionBar {mail} {labels} {...actions} />
  <header class="head">
    <h2>{mail.subject || '(sans objet)'}</h2>
    <p class="meta">
      <span class="from">{sender(detail?.from ?? mail.from)}</span>
      <span class="addr">&lt;{(detail?.from ?? mail.from).addr}&gt;</span>
    </p>
    {#if detail}
      <p class="meta">
        À : {detail.to}{#if detail.cc}
          · Cc : {detail.cc}{/if}
      </p>
    {/if}
    <p class="meta">{longDate(mail.date)}</p>
    {#if detail?.attachments.length}
      <ul class="attachments" aria-label="Pièces jointes">
        {#each detail.attachments as a (a.id)}
          <li><button type="button" onclick={() => download(a)}>{a.filename} · {size(a.size)}</button></li>
        {/each}
      </ul>
    {/if}
  </header>
  {#if detail}
    <MailFrame html={detail.html} />
  {:else}
    <p class="loading">Chargement du mail…</p>
  {/if}
</section>

<style>
  .reader {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface);
  }
  .head {
    padding: 0.75rem 1rem 0.5rem;
  }
  h2 {
    margin: 0 0 0.4rem;
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.5rem;
  }
  .meta {
    margin: 0.1rem 0;
    font-size: 0.85rem;
    color: var(--lune);
  }
  .from {
    color: var(--ivoire);
    font-weight: 400;
  }
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.8rem;
  }
  .loading {
    padding: 1rem;
    color: var(--lune);
  }
</style>
