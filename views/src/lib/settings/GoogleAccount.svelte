<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { GoogleStatus } from '../types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import SettingsRow from '../ui/SettingsRow.svelte';

  /** The Google account: its state first, its address, then connecting or disconnecting (confirmed). */

  interface Props {
    client: AcediaClient;
    status: GoogleStatus | null;
    /** The code of a return from Google (`/?google=failed`); cleared once connecting again. */
    notice?: string | undefined;
  }
  let { client, status = $bindable(), notice = $bindable() }: Props = $props();

  /** What a return from Google says, by its code; any other code says nothing (Google's word is never shown). */
  const NOTICES: Record<string, { text: string; alert: boolean }> = {
    refused: { text: 'Connexion annulée sur la page de Google. Rien n’a changé.', alert: false },
    failed: { text: 'Google n’a pas confirmé la connexion. Rien n’a changé : recommencer.', alert: true },
    expired: {
      text: 'Ce retour de Google n’est plus valable. Rien n’a changé : recommencer la connexion.',
      alert: true,
    },
  };
  // Own keys only: `NOTICES.constructor` exists too.
  const said = $derived(notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined);

  let disconnecting = $state(false);
  let error = $state<string | null>(null);

  async function refresh() {
    try {
      status = await client.googleStatus();
    } catch (err) {
      error = errorText(err);
    }
  }

  async function connect() {
    error = null;
    notice = undefined;
    try {
      // Google's consent page opens beside; the status refreshes when coming back.
      window.open((await client.googleAuthUrl()).url, '_blank', 'noopener');
    } catch (err) {
      error = errorText(err);
    }
  }

  async function disconnect() {
    await client.googleDisconnect();
    await refresh();
  }
</script>

<svelte:window onfocus={refresh} />

<SettingsCard title="Compte Google" description="Mail, agenda et tâches passent par ce compte.">
  {#snippet aside()}
    {#if status}
      <Badge tone={status.connected ? 'ok' : 'attention'} dot
        >{status.connected ? 'Connecté' : 'Non connecté'}</Badge
      >
    {/if}
  {/snippet}
  <!-- What happened on Google's side, read before the rows: a refusal is neutral, a failure an alert. -->
  {#if said?.alert}
    <p class="avis alerte" role="alert">{said.text}</p>
  {:else if said}
    <p class="avis" role="status">{said.text}</p>
  {/if}
  {#if status?.connected}
    <SettingsRow label="Adresse" hint={status.email ?? 'compte Google'} />
    <SettingsRow
      label="Autorisations"
      hint="Gmail (lecture, modification, envoi, adresses d’envoi) · Agenda · Tâches"
    />
    <SettingsRow
      label="Déconnecter le compte"
      hint="Le tri et la synchronisation s’arrêtent jusqu’à une reconnexion."
    >
      <Button variant="danger" size="petit" onclick={() => (disconnecting = true)}>Déconnecter</Button>
    </SettingsRow>
  {:else if status}
    <SettingsRow
      label="Aucun compte"
      hint={status.unreadable
        ? 'Le compte enregistré ne se lit pas avec la clé de ce serveur. Si elle a changé par erreur, remettre l’ancienne ; sinon, connecter le compte de nouveau.'
        : 'Gmail, Agenda et Tâches sont inaccessibles. Seul le compte Google qui a créé le projet d’Acedia peut se connecter.'}
    >
      <Button variant="principal" size="petit" onclick={connect}>Connecter un compte Google</Button>
    </SettingsRow>
  {:else}
    <SettingsRow label="Vérification…" />
  {/if}
  {#if error}<p class="erreur" role="alert">{error}</p>{/if}
</SettingsCard>

<ConfirmDialog
  bind:open={disconnecting}
  title="Déconnecter le compte Google ?"
  message="Lun'Acedia ne lira plus les mails, l’agenda ni les tâches de ce compte. Les réglages sont conservés."
  confirmLabel="Déconnecter le compte"
  onconfirm={disconnect}
/>

<style>
  /* A row of its own under the title, in the type of the rows' help. */
  .avis {
    margin: 0;
    padding: 12px 18px;
    border-bottom: 1px solid var(--bordure);
    font-size: 12.5px;
    color: var(--texte-2);
  }
  .alerte {
    color: var(--danger);
  }
  .erreur {
    margin: 0;
    padding: 0 18px 14px;
    font-size: 12.5px;
    color: var(--danger);
  }
</style>
