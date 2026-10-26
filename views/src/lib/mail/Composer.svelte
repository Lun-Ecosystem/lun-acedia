<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import type { Draft, MailDetail, SendAsAddress } from '../types.ts';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import { Send, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import Select from '../ui/Select.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import { errorText, escapeHtml } from './format.ts';

  interface Props {
    client: AcediaClient;
    replyTo?: MailDetail | undefined;
    /** Mail forwarded: its text goes under the message; its attachments do not follow. */
    forward?: MailDetail | undefined;
    onclose: () => void;
    onsent: () => void;
  }
  let { client, replyTo, forward, onclose, onsent }: Props = $props();
  const title = $derived(replyTo ? 'Répondre' : forward ? 'Transférer' : 'Nouveau message');

  let addresses = $state<SendAsAddress[]>([]);
  let from = $state('');
  // The fields start from the mail answered, then belong to the person writing.
  const start = untrack(() => ({
    to: replyTo?.from.addr ?? '',
    subject: replyTo
      ? /^re\s*:/i.test(replyTo.subject)
        ? replyTo.subject
        : `Re: ${replyTo.subject}`
      : forward
        ? `Tr : ${forward.subject}`
        : '',
  }));
  let to = $state(start.to);
  let cc = $state('');
  let subject = $state(start.subject);
  let body = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    client
      .sendAs(replyTo?.id)
      .then((r) => {
        addresses = r.addresses;
        from = r.default;
      })
      .catch((err) => (error = errorText(err)));
  });

  /** The forwarded mail under the message, without the viewing guards the server added for the reader. */
  const forwarded = (m: MailDetail) =>
    '<br><div>---------- Message transféré ----------<br>' +
    `De : ${escapeHtml(m.from.name ? `${m.from.name} <${m.from.addr}>` : m.from.addr)}<br>` +
    `Date : ${escapeHtml(m.date)}<br>Objet : ${escapeHtml(m.subject)}<br>À : ${escapeHtml(m.to)}</div><br>` +
    m.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>|<base [^>]*>/gi, '');

  const label = (a: SendAsAddress) => (a.name ? `${a.name} <${a.email}>` : a.email);

  async function send(event: SubmitEvent) {
    event.preventDefault();
    sending = true;
    error = null;
    const chosen = addresses.find((a) => a.email === from);
    const draft: Draft = {
      from: chosen ? label(chosen) : from,
      to,
      subject,
      html: `<div>${escapeHtml(body).replace(/\n/g, '<br>')}</div>${forward ? forwarded(forward) : ''}`,
      text: body,
    };
    if (cc) draft.cc = cc;
    if (replyTo) draft.threadId = replyTo.threadId;
    try {
      await client.send(draft);
      onsent();
    } catch (err) {
      error = errorText(err);
    } finally {
      sending = false;
    }
  }
</script>

<form class="composer" aria-label={title} onsubmit={send}>
  <header>
    <h2>{title}</h2>
    <IconButton icon={X} label="Fermer" onclick={onclose} />
  </header>
  <div class="champs">
    <Field label="De">
      <Select bind:value={from} items={addresses.map((a) => ({ value: a.email, label: label(a) }))} />
    </Field>
    <Field label="À">
      <TextInput bind:value={to} required autocomplete="email" />
    </Field>
    <Field label="Cc">
      <TextInput bind:value={cc} />
    </Field>
    <Field label="Objet">
      <TextInput bind:value={subject} />
    </Field>
  </div>
  <textarea bind:value={body} rows="12" aria-label="Message"></textarea>
  {#if error}<Banner title={error} />{/if}
  <div class="actions">
    <Button variant="fantome" onclick={onclose}>Fermer</Button>
    <Button type="submit" variant="principal" icon={Send} loading={sending} disabled={!from}>Envoyer</Button>
  </div>
</form>

<style>
  .composer {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
    min-height: 0;
    padding: 18px 34px 24px;
    background: var(--fond);
    box-sizing: border-box;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font: 500 26px/1.2 var(--serif);
  }
  .champs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 16px;
  }
  textarea {
    flex: 1;
    min-height: 160px;
    padding: 12px 14px;
    resize: vertical;
    background: var(--surface-1);
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
    color: var(--texte);
    font: 300 14.5px/1.6 var(--sans);
  }
  textarea:focus-visible {
    border-color: var(--accent-bord);
    outline: 2px solid var(--accent-texte);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 767.98px) {
    .composer {
      position: fixed;
      inset: 0;
      z-index: 45;
      padding: max(12px, env(safe-area-inset-top)) 16px 16px;
    }
    .champs {
      grid-template-columns: 1fr;
    }
  }
</style>
