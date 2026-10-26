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
  }
  let { client, status = $bindable() }: Props = $props();

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
  {#if status?.connected}
    <SettingsRow label="Adresse" hint={status.email ?? 'compte Google'} />
    <SettingsRow label="Autorisations" hint="Gmail (lecture, modification) · Agenda · Tâches" />
    <SettingsRow
      label="Déconnecter le compte"
      hint="Le tri et la synchronisation s’arrêtent jusqu’à une reconnexion."
    >
      <Button variant="danger" size="petit" onclick={() => (disconnecting = true)}>Déconnecter</Button>
    </SettingsRow>
  {:else if status}
    <SettingsRow label="Aucun compte" hint="Gmail, Agenda et Tâches sont inaccessibles.">
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
  .erreur {
    margin: 0;
    padding: 0 18px 14px;
    font-size: 12.5px;
    color: var(--danger);
  }
</style>
