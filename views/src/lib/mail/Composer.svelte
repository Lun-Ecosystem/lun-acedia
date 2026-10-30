<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import type { Draft, DraftView, MailDetail, SendAsAddress } from '../types.ts';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Field from '../ui/Field.svelte';
  import { ICON_STROKE, Send, Sparkles, Trash, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import Select from '../ui/Select.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import { toast } from '../ui/toasts.svelte.ts';
  import { agentIdentity } from '../pina/identity.svelte.ts';
  import { errorText, escapeHtml } from './format.ts';

  interface Props {
    client: AcediaClient;
    replyTo?: MailDetail | undefined;
    /** Mail forwarded: its text goes under the message; its attachments do not follow. */
    forward?: MailDetail | undefined;
    /**
     * A saved draft (Pina's): read by its id, saved, sent and thrown away through `/api/drafts/:id`.
     * Pina never sends; the « Envoyer » here is the only way it leaves.
     */
    draftId?: string | undefined;
    onclose: () => void;
    onsent: () => void;
  }
  let { client, replyTo, forward, draftId, onclose, onsent }: Props = $props();
  /** The draft as read, for its thread; `null` until it is (or when the composer is not on a draft). */
  let draft = $state.raw<DraftView | null>(null);
  const title = $derived(
    draftId
      ? draft?.replyTo
        ? 'Brouillon de réponse'
        : 'Brouillon'
      : replyTo
        ? 'Répondre'
        : forward
          ? 'Transférer'
          : 'Nouveau message',
  );

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
  let saving = $state(false);
  let discarding = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    if (draftId)
      client.getDraft(draftId).then(
        (d) => {
          draft = d;
          to = d.to;
          cc = d.cc ?? '';
          subject = d.subject;
          body = d.text;
          pickFrom();
        },
        (err) => (error = errorText(err)),
      );
    client
      .sendAs(replyTo?.id)
      .then((r) => {
        addresses = r.addresses;
        fallback = r.default;
        pickFrom();
      })
      .catch((err) => (error = errorText(err)));
  });

  /** The server's default sender, used unless the draft names one of the aliases. */
  let fallback = '';
  /** A draft keeps the alias it was written from (whichever answer comes last decides). */
  function pickFrom() {
    const own = draft?.from?.toLowerCase();
    from = addresses.find((a) => a.email.toLowerCase() === own)?.email ?? fallback;
  }

  /** The forwarded mail under the message, without the viewing guards the server added for the reader. */
  const forwarded = (m: MailDetail) =>
    '<br><div>---------- Message transféré ----------<br>' +
    `De : ${escapeHtml(m.from.name ? `${m.from.name} <${m.from.addr}>` : m.from.addr)}<br>` +
    `Date : ${escapeHtml(m.date)}<br>Objet : ${escapeHtml(m.subject)}<br>À : ${escapeHtml(m.to)}</div><br>` +
    m.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>|<base [^>]*>/gi, '');

  const label = (a: SendAsAddress) => (a.name ? `${a.name} <${a.email}>` : a.email);

  /** The message as written now. */
  function message(): Draft {
    const chosen = addresses.find((a) => a.email === from);
    const out: Draft = {
      from: chosen ? label(chosen) : from,
      to,
      subject,
      html: `<div>${escapeHtml(body).replace(/\n/g, '<br>')}</div>${forward ? forwarded(forward) : ''}`,
      text: body,
    };
    if (cc) out.cc = cc;
    if (replyTo) out.threadId = replyTo.threadId;
    // A draft's reply stays in its thread: `replyTo.id` is the Message-ID answered.
    if (draft?.replyTo) {
      out.threadId = draft.replyTo.threadId;
      out.inReplyTo = out.references = draft.replyTo.id;
    }
    return out;
  }

  async function save() {
    if (!draftId) return;
    saving = true;
    error = null;
    try {
      draft = await client.updateDraft(draftId, message());
      toast('Brouillon enregistré');
    } catch (err) {
      error = errorText(err);
    } finally {
      saving = false;
    }
  }

  async function discard() {
    if (!draftId) return;
    await client.deleteDraft(draftId);
    toast('Brouillon jeté');
    onclose();
  }

  async function send() {
    sending = true;
    error = null;
    try {
      if (draftId) {
        // What was read and changed here is what leaves: saved into the draft, then that draft is sent.
        await client.updateDraft(draftId, message());
        await client.sendDraft(draftId);
      } else await client.send(message());
      onsent();
    } catch (err) {
      error = errorText(err);
    } finally {
      sending = false;
    }
  }
</script>

<!-- No implicit submit: Enter in a field must never send; only a click on « Envoyer » does. -->
<form class="composer" aria-label={title} onsubmit={(e) => e.preventDefault()}>
  <header>
    <h2>{title}</h2>
    <IconButton icon={X} label="Fermer" onclick={onclose} />
  </header>
  {#if draftId}
    <p class="bandeau-ia">
      <Sparkles size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <span
        ><b>Brouillon préparé par {agentIdentity.name}.</b> Relire avant d’envoyer : rien ne part sans un clic sur
        Envoyer.</span
      >
    </p>
  {/if}
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
  <!-- On the left, Envoyer first (Gmail's order): the bottom-right corner belongs to Pina's window. -->
  <div class="actions gauche">
    <Button
      variant="principal"
      icon={Send}
      loading={sending}
      disabled={!from || !to.trim() || (draftId !== undefined && !draft)}
      onclick={send}>Envoyer</Button
    >
    {#if draftId}
      <Button variant="secondaire" loading={saving} disabled={!from || !draft} onclick={save}
        >Enregistrer</Button
      >
      <Button variant="fantome" icon={Trash} disabled={!draft} onclick={() => (discarding = true)}
        >Jeter</Button
      >
    {/if}
    <Button variant="fantome" class="fermer-bas" onclick={onclose}>Fermer</Button>
  </div>
</form>

{#if draftId}
  <ConfirmDialog
    bind:open={discarding}
    title="Jeter le brouillon ?"
    message="Le brouillon est retiré des brouillons Gmail. Rien n’est envoyé."
    confirmLabel="Jeter"
    onconfirm={discard}
  />
{/if}

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
  .bandeau-ia {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 10px 14px;
    border: 1px solid var(--ia-bord);
    border-radius: var(--r-2);
    background: var(--ia-doux);
    color: var(--texte-2);
    font-size: 13px;
  }
  .bandeau-ia :global(svg) {
    flex: none;
    color: var(--ia);
  }
  .bandeau-ia b {
    color: var(--texte);
    font-weight: 500;
  }
  .actions {
    display: flex;
    justify-content: flex-start;
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
    /* A draft's actions fill the width: the header's close button is enough on a phone. */
    .composer:has(.bandeau-ia) .actions :global(.fermer-bas) {
      display: none;
    }
  }
</style>
