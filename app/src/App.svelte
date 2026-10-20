<script lang="ts">
  import { Agenda, Journal, Mailbox, Settings } from '@lun-ecosystem/lunacedia-views';
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

  function forget() {
    clearToken(localStorage);
    token = null;
    notice = 'Cet appareil n’est plus reconnu : relie-le avec un nouveau code.';
  }

  const client = $derived(token ? createHttpClient(baseUrl, token, { onUnauthorized: forget }) : null);

  function paired(t: string) {
    saveToken(localStorage, t);
    notice = null;
    token = t;
  }
</script>

{#if client}
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
          <Settings {client} />
        {/if}
      {/key}
    </main>
  </div>
{:else}
  <Pair {baseUrl} {notice} onPaired={paired} />
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
  @media (max-width: 560px) {
    .name {
      display: none;
    }
    nav button {
      flex: 1;
    }
  }
</style>
