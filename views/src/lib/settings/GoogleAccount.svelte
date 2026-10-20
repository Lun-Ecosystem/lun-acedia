<script lang="ts">
  import { onMount } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { GoogleStatus } from '../types.ts';

  let { client }: { client: AcediaClient } = $props();

  let status = $state<GoogleStatus | null>(null);
  let error = $state<string | null>(null);

  async function refresh() {
    try {
      status = await client.googleStatus();
    } catch (err) {
      error = errorText(err);
    }
  }
  onMount(() => {
    void refresh();
  });

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
    error = null;
    try {
      await client.googleDisconnect();
      await refresh();
    } catch (err) {
      error = errorText(err);
    }
  }
</script>

<svelte:window onfocus={refresh} />

<section aria-label="Compte Google">
  <h3>Compte Google</h3>
  {#if status === null}
    <p class="hint">Vérification…</p>
  {:else if status.connected}
    <p>Connecté : {status.email ?? 'compte Google'}</p>
    <button type="button" onclick={disconnect}>Déconnecter</button>
  {:else}
    <p>Non connecté : Gmail, Agenda et Tâches sont inaccessibles.</p>
    <button type="button" onclick={connect}>Connecter un compte Google</button>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
