<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import type { Draft, MailDetail, SendAsAddress } from '../types.ts';
  import { errorText, escapeHtml } from './format.ts';

  interface Props {
    client: AcediaClient;
    replyTo?: MailDetail | undefined;
    onclose: () => void;
    onsent: () => void;
  }
  let { client, replyTo, onclose, onsent }: Props = $props();

  let addresses = $state<SendAsAddress[]>([]);
  let from = $state('');
  // The fields start from the mail answered, then belong to the person writing.
  const start = untrack(() => ({
    to: replyTo?.from.addr ?? '',
    subject: !replyTo ? '' : /^re\s*:/i.test(replyTo.subject) ? replyTo.subject : `Re: ${replyTo.subject}`,
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
      html: `<div>${escapeHtml(body).replace(/\n/g, '<br>')}</div>`,
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

<form class="composer" aria-label="Nouveau message" onsubmit={send}>
  <label
    >De <select bind:value={from}>
      {#each addresses as a (a.email)}<option value={a.email}>{label(a)}</option>{/each}
    </select></label
  >
  <label>À <input bind:value={to} required type="text" autocomplete="email" /></label>
  <label>Cc <input bind:value={cc} type="text" /></label>
  <label>Objet <input bind:value={subject} type="text" /></label>
  <textarea bind:value={body} rows="12" aria-label="Message"></textarea>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button type="submit" disabled={sending || !from}>{sending ? 'Envoi…' : 'Envoyer'}</button>
    <button type="button" onclick={onclose}>Fermer</button>
  </div>
</form>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    background: var(--surface);
    height: 100%;
    box-sizing: border-box;
  }
  label {
    display: grid;
    grid-template-columns: 3.5rem 1fr;
    align-items: center;
    font-size: 0.85rem;
    color: var(--lune);
  }
  textarea {
    flex: 1;
    resize: vertical;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .error {
    color: var(--erreur);
  }
</style>
