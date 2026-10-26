<script lang="ts">
  import type { AcediaClient, AnthropicKeyStatus } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import Field from '../ui/Field.svelte';
  import { Calendar, ICON_STROKE, Plus } from '../ui/Icon.ts';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import SettingsRow from '../ui/SettingsRow.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import { toast } from '../ui/toasts.svelte.ts';
  import type { Tone } from '../ui/types.ts';

  /*
   * Card of the Anthropic key: its state first, then the key by its last 4 characters only. Replacing
   * opens a window (the check with Anthropic can take seconds); removing asks for a confirmation.
   */

  interface Props {
    client: AcediaClient;
    status: AnthropicKeyStatus | null;
    /** The replacing window, opened from here or from the banner of a refused key. */
    replacing?: boolean | undefined;
  }
  let { client, status = $bindable(), replacing = $bindable(false) }: Props = $props();

  const uid = $props.id();
  let key = $state('');
  let expires = $state('');
  let pending = $state(false);
  let error = $state<string | undefined>();
  let removing = $state(false);

  const BADGE: Record<AnthropicKeyStatus['state'], { text: string; tone: Tone }> = {
    ok: { text: 'En service', tone: 'ok' },
    refused: { text: 'Refusée', tone: 'danger' },
    credit: { text: 'Crédit épuisé', tone: 'attention' },
    absent: { text: 'Absente', tone: 'neutre' },
  };

  $effect(() => {
    if (!replacing) {
      key = '';
      expires = '';
      error = undefined;
    }
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!key.trim() || pending) return;
    pending = true;
    error = undefined;
    try {
      // On refusal nothing changes on the server: the window stays, with the reason.
      status = await client.saveAnthropicKey(key.trim(), expires || undefined);
      replacing = false;
      toast('Clé vérifiée et enregistrée');
    } catch (err) {
      error = errorText(err);
    } finally {
      pending = false;
    }
  }

  let retrying = $state(false);

  /** The state could not be read: asks again. */
  async function retry() {
    retrying = true;
    try {
      status = await client.getAnthropicKey();
    } catch (err) {
      toast(errorText(err), { tone: 'danger' });
    } finally {
      retrying = false;
    }
  }

  async function remove() {
    status = await client.deleteAnthropicKey();
    toast('Clé Anthropic retirée');
  }

  /** `AAAA-MM-JJ` as « 12 mars 2027 », without going through the local time zone. */
  const day = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
</script>

<SettingsCard
  title="Clé Anthropic"
  description="Utilisée seulement pour classer les mails. Jamais affichée en entier."
  class="cle"
>
  {#snippet aside()}
    {#if status}<Badge tone={BADGE[status.state].tone} dot>{BADGE[status.state].text}</Badge>{/if}
  {/snippet}
  {#if status?.last4}
    <SettingsRow label={status.source === 'env' ? 'Clé du fichier .env' : 'Clé enregistrée'}>
      {#snippet hint()}Se termine par <span class="mono">{status?.last4}</span>{/snippet}
      <Button size="petit" onclick={() => (replacing = true)}>Remplacer…</Button>
      {#if status.source !== 'env'}
        <Button variant="fantome" size="petit" class="retirer" onclick={() => (removing = true)}
          >Retirer</Button
        >
      {/if}
    </SettingsRow>
    <SettingsRow label="Échéance déclarée" hint="Avertissement 14 jours puis 3 jours avant.">
      <span class="puce">
        <Calendar size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {status.expires ? day(status.expires) : 'Aucune'}
      </span>
    </SettingsRow>
  {:else if status}
    <SettingsRow label="Aucune clé" hint="Seules les règles trient les nouveaux mails.">
      <Button variant="principal" size="petit" icon={Plus} onclick={() => (replacing = true)}
        >Ajouter une clé</Button
      >
    </SettingsRow>
  {:else}
    <SettingsRow label="État de la clé inconnu" hint="La clé n’a pas pu être lue.">
      <Button size="petit" loading={retrying} onclick={retry}>Réessayer</Button>
      <Button size="petit" onclick={() => (replacing = true)}>Remplacer…</Button>
    </SettingsRow>
  {/if}
</SettingsCard>

<!-- A check in progress keeps the window open: its answer, a refusal included, must be seen. -->
<Dialog
  bind:open={
    () => replacing,
    (next) => {
      if (!pending) replacing = next;
    }
  }
  title={status?.last4 ? 'Remplacer la clé' : 'Ajouter une clé'}
  description="Vérifiée auprès d’Anthropic avant d’être enregistrée, elle sert dès le mail suivant."
>
  {#snippet children()}
    <form id="{uid}-cle" class="champs" onsubmit={save}>
      <Field label="Nouvelle clé" {error}>
        <TextInput
          type="password"
          autocomplete="off"
          spellcheck="false"
          autocapitalize="off"
          bind:value={key}
          disabled={pending}
        />
      </Field>
      <Field label="Échéance (facultatif)" hint="Avertissement 14 jours puis 3 jours avant.">
        <TextInput type="date" bind:value={expires} disabled={pending} />
      </Field>
      {#if pending}<p class="attente" role="status">Vérification auprès d’Anthropic…</p>{/if}
    </form>
  {/snippet}
  {#snippet footer({ close })}
    <Button onclick={close} disabled={pending}>Annuler</Button>
    <Button type="submit" form="{uid}-cle" variant="principal" loading={pending} disabled={!key.trim()}
      >Vérifier et enregistrer</Button
    >
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={removing}
  title="Retirer la clé Anthropic ?"
  message="Le tri par l’IA s’arrête ; les règles continuent de s’appliquer. Une nouvelle clé peut être ajoutée à tout moment."
  confirmLabel="Retirer la clé"
  onconfirm={remove}
/>

<style>
  .mono {
    font:
      400 13px ui-monospace,
      Consolas,
      monospace;
    color: var(--texte-2);
  }
  .puce {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-1);
    background: var(--surface-2);
    font-size: 13px;
    color: var(--texte);
    white-space: nowrap;
  }
  .puce :global(svg) {
    color: var(--texte-3);
  }
  :global(.cle) :global(.btn.retirer) {
    color: var(--danger);
  }
  .champs {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .attente {
    margin: 0;
    font-size: 12.5px;
    color: var(--texte-2);
  }
</style>
