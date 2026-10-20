<script lang="ts">
  import type { AcediaClient, AuthorizationRequest } from '@lun-ecosystem/lunacedia-views';
  import { returnHost } from './authorization.ts';

  let {
    client,
    request,
    navigate = (url: string) => window.location.assign(url),
  }: {
    client: AcediaClient;
    request: AuthorizationRequest;
    /** Sends the browser back to the requesting app. */
    navigate?: (url: string) => void;
  } = $props();

  const RIGHTS = [
    'lire l’état, les coûts et les événements',
    'lire et ranger les mails',
    'gérer l’agenda, les tâches et les rappels',
    'mettre en pause et reprendre le service',
  ];

  let busy = $state(false);
  let error = $state<string | null>(null);

  // Only an explicit click sends the decision; the buttons stay off until the browser leaves.
  async function decide(decision: 'allow' | 'deny') {
    busy = true;
    error = null;
    try {
      const { redirect } = await client.authorize({ ...request, decision });
      navigate(redirect);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }
</script>

<main class="authorize lun-acedia">
  <p class="brand">Lun'Acedia</p>
  <h1>{request.client} demande l’accès à Lun'Acedia</h1>
  <p>Une fois reliée, cette application pourra :</p>
  <ul>
    {#each RIGHTS as right (right)}
      <li>{right}</li>
    {/each}
  </ul>
  <p class="return">Retour vers {returnHost(request.redirect_uri)}</p>
  <div class="actions">
    <button type="button" class="primary" disabled={busy} onclick={() => decide('allow')}>Autoriser</button>
    <button type="button" disabled={busy} onclick={() => decide('deny')}>Refuser</button>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <p class="note">Accès retirable à tout moment dans Réglages, Appareils et applications.</p>
</main>

<style>
  .authorize {
    max-width: 30rem;
    margin: 0 auto;
    padding: 18vh 1rem 2rem;
    min-height: 100dvh;
    box-sizing: border-box;
  }
  .brand {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.35rem;
    margin: 0 0 1.25rem;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 2rem;
    line-height: 1.2;
    margin: 0 0 1rem;
    overflow-wrap: anywhere;
  }
  p {
    color: var(--lune);
    line-height: 1.5;
    margin: 0 0 0.6rem;
  }
  ul {
    margin: 0 0 1.25rem;
    padding-left: 1.2rem;
    color: var(--papier);
    line-height: 1.6;
  }
  .return {
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    gap: 0.6rem;
    margin: 1.25rem 0 0.8rem;
  }
  .actions button {
    padding: 0.45rem 1rem;
  }
  .actions .primary {
    background: var(--monde-accent);
    border-color: var(--monde-accent);
  }
  .note {
    margin-top: 1.5rem;
    font-size: 0.85rem;
  }
  .error {
    color: var(--erreur);
  }
</style>
