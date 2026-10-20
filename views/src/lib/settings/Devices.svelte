<script lang="ts">
  import { onMount } from 'svelte';
  import type { AcediaClient, LinkedClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';

  let {
    client,
    onSelfRevoked,
  }: {
    client: AcediaClient;
    /** Called once this browser's own access is revoked: its token no longer works. */
    onSelfRevoked?: (() => void) | undefined;
  } = $props();

  let clients = $state<LinkedClient[]>([]);
  let confirming = $state(false);
  let busy = $state(false);
  let done = $state<string | null>(null);
  let code = $state<{ code: string; expiresAt: string } | null>(null);
  let error = $state<string | null>(null);

  onMount(() => {
    client
      .listClients()
      .then((c) => (clients = c))
      .catch((err) => (error = errorText(err)));
  });

  function ask(c: LinkedClient) {
    error = null;
    done = null;
    if (c.current) confirming = true;
    else void revoke(c);
  }

  async function revoke(c: LinkedClient) {
    busy = true;
    error = null;
    try {
      await client.revokeClient(c.id);
      if (c.current && onSelfRevoked) {
        // The token is dead: no further call, the host app goes back to pairing.
        onSelfRevoked();
        return;
      }
      clients = clients.filter((x) => x.id !== c.id);
      confirming = false;
      done = `Accès retiré : ${c.current ? 'ce navigateur' : c.name}.`;
    } catch (err) {
      error = errorText(err);
    } finally {
      busy = false;
    }
  }

  async function link() {
    error = null;
    try {
      code = await client.createPairingCode();
    } catch (err) {
      error = errorText(err);
    }
  }

  const date = (iso: string) => new Date(iso).toLocaleDateString('fr-FR');
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const kind = (c: LinkedClient) =>
    c.kind === 'app'
      ? `application · reliée le ${date(c.createdAt)}`
      : `appareil · relié le ${date(c.createdAt)}`;
</script>

<section class="devices" aria-label="Appareils et applications">
  <h3>Appareils et applications</h3>
  <p class="hint">Ce qui a accès à Lun'Acedia.</p>
  <ul>
    {#each clients as c (c.id)}
      <li>
        <span class="who">
          <span>{c.current ? 'Ce navigateur' : c.name}</span>
          <span class="meta">{kind(c)}</span>
        </span>
        <button type="button" disabled={busy} onclick={() => ask(c)}>Retirer</button>
      </li>
      {#if c.current && confirming}
        <li class="confirm">
          <span
            >Ce navigateur perdra l’accès à Lun'Acedia. Un nouveau code sera nécessaire pour le relier.</span
          >
          <button type="button" disabled={busy} onclick={() => revoke(c)}>Retirer ce navigateur</button>
          <button type="button" disabled={busy} onclick={() => (confirming = false)}>Annuler</button>
        </li>
      {/if}
    {/each}
  </ul>
  {#if done}<p class="ok" role="status">{done}</p>{/if}
  <button type="button" onclick={link}>Relier un appareil</button>
  {#if code}
    <p class="code">{code.code}</p>
    <p class="hint">Expire à {time(code.expiresAt)}</p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .devices li {
    border: 1px solid var(--bordure);
    border-radius: var(--rayon);
    padding: 0.55rem 0.75rem;
    margin-bottom: 0.5rem;
  }
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.2rem 0.6rem;
  }
  .meta {
    font-size: 0.85rem;
    color: var(--lune);
  }
  .devices .confirm {
    flex-wrap: wrap;
    border-color: var(--monde-accent);
    background: var(--accent-doux);
  }
  .code {
    margin: 0.75rem 0 0.25rem;
    font-family: var(--serif);
    font-size: 2.2rem;
    letter-spacing: 0.3em;
  }
</style>
