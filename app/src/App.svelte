<script lang="ts">
  import { Agenda, Journal, Mailbox, Settings } from '@lun-ecosystem/lunacedia-views';
  import { readAuthorization } from './authorization.ts';
  import Authorize from './Authorize.svelte';
  import { createHttpClient } from './httpClient.ts';
  import Pair from './Pair.svelte';
  import { clearToken, loadToken, saveToken } from './session.ts';

  type Tab = 'mail' | 'agenda' | 'journal' | 'settings';
  const TABS: { id: Tab; label: string }[] = [
    { id: 'mail', label: 'Mail' },
    { id: 'agenda', label: 'Agenda' },
    { id: 'journal', label: 'Journal' },
    { id: 'settings', label: 'Réglages' },
  ];

  // The app is served by Lun'Acedia itself (or proxied to it in development).
  const baseUrl = window.location.origin;

  let token = $state(loadToken(localStorage));
  let notice = $state<string | null>(null);

  // Back from Google's consent page: land on the settings, where the account shows as connected.
  const params = new URLSearchParams(window.location.search);
  let tab = $state<Tab>(params.has('google') ? 'settings' : 'mail');
  if (params.has('google')) history.replaceState(null, '', window.location.pathname);

  // An app asks for access (`GET /lun/v1/authorize`): the request waits here, through pairing if needed.
  let authorization = $state(readAuthorization(window.location.search));

  /** Leaves the authorization page for the app itself, without the request in the address. */
  function leaveAuthorization() {
    authorization = null;
    history.replaceState(null, '', window.location.pathname);
  }

  function signOut(message: string) {
    clearToken(localStorage);
    token = null;
    notice = message;
  }

  // Ignored once the token is gone: a late 401 does not reset the pairing screen.
  function forget() {
    if (token) signOut('Cet appareil n’est plus reconnu. Saisir un nouveau code pour le relier.');
  }

  function revokedSelf() {
    signOut("Ce navigateur n’a plus accès à Lun'Acedia.");
  }

  const client = $derived(token ? createHttpClient(baseUrl, token, { onUnauthorized: forget }) : null);

  function paired(t: string) {
    saveToken(localStorage, t);
    notice = null;
    token = t;
  }
</script>

{#if authorization && 'error' in authorization}
  <main class="refused lun-acedia">
    <p class="brand">Lun'Acedia</p>
    <p class="error" role="alert">{authorization.error}</p>
    <button type="button" onclick={leaveAuthorization}>Ouvrir Lun'Acedia</button>
  </main>
{:else if client && authorization}
  <Authorize {client} request={authorization.request} />
{:else if client}
  <div class="shell lun-acedia">
    <nav aria-label="Sections">
      <span class="name">Lun'Acedia</span>
      {#each TABS as t (t.id)}
        <button type="button" aria-current={tab === t.id ? 'page' : undefined} onclick={() => (tab = t.id)}
          >{t.label}</button
        >
      {/each}
    </nav>
    <main>
      {#key client}
        {#if tab === 'mail'}
          <Mailbox {client} />
        {:else if tab === 'agenda'}
          <Agenda {client} />
        {:else if tab === 'journal'}
          <Journal {client} />
        {:else}
          <Settings {client} onSelfRevoked={revokedSelf} />
        {/if}
      {/key}
    </main>
  </div>
{:else}
  <Pair {baseUrl} {notice} authorizing={authorization !== null} onPaired={paired} />
{/if}

<style>
  :global(html, body) {
    margin: 0;
    background: var(--monde-fond);
    color-scheme: dark;
  }
  .shell {
    display: grid;
    grid-template-rows: auto 1fr;
    height: 100dvh;
  }
  nav {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    padding-top: max(0.5rem, env(safe-area-inset-top));
    border-bottom: 1px solid var(--bordure);
    overflow-x: auto;
  }
  .name {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.35rem;
    margin-right: auto;
    white-space: nowrap;
  }
  nav button[aria-current='page'] {
    border-color: var(--monde-accent);
    background: var(--accent-doux);
  }
  main {
    min-height: 0;
    overflow: hidden;
  }
  .refused {
    max-width: 30rem;
    margin: 0 auto;
    padding: 18vh 1rem 2rem;
    min-height: 100dvh;
    box-sizing: border-box;
    overflow: visible;
  }
  .refused .brand {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.35rem;
    margin: 0 0 1.25rem;
  }
  .refused .error {
    color: var(--erreur);
    line-height: 1.5;
  }
  @media (max-width: 560px) {
    .name {
      display: none;
    }
    nav button {
      flex: 1;
    }
  }
</style>
