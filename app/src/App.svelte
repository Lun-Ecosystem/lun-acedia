<script lang="ts">
  import { untrack } from 'svelte';
  import {
    Agenda,
    Journal,
    Mailbox,
    Settings,
    toast,
    type AcediaClient,
  } from '@lun-ecosystem/lunacedia-views';
  import { readAuthorization } from './authorization.ts';
  import Authorize from './Authorize.svelte';
  import { createHttpClient } from './httpClient.ts';
  import Pair from './Pair.svelte';
  import Shell, { HREF, type Screen } from './shell/Shell.svelte';
  import { readStatus, type ShellStatus } from './shell/status.ts';
  import { clearToken, loadToken, saveToken } from './session.ts';

  // The app is served by Lun'Acedia itself (or proxied to it in development).
  const baseUrl = window.location.origin;

  let token = $state(loadToken(localStorage));
  let notice = $state<string | null>(null);

  // Back from Google's consent page: land on the settings, where the account shows as connected.
  const params = new URLSearchParams(window.location.search);
  if (params.has('google')) history.replaceState(null, '', `${window.location.pathname}${HREF.reglages}`);

  /** The screen shown, from the hash of the page (`#/agenda`); the mail by default. */
  const screenOf = (hash: string): Screen =>
    (Object.keys(HREF) as Screen[]).find((s) => HREF[s] === hash) ?? 'mail';
  let screen = $state(screenOf(window.location.hash));
  $effect(() => {
    const follow = () => (screen = screenOf(window.location.hash));
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  });

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

  let status = $state<ShellStatus>({
    counts: { inbox: 0, pending: 0, tasks: 0 },
    service: 'actif',
    detail: '',
  });
  let account = $state<string | undefined>();

  async function refresh(c: AcediaClient) {
    const next = await readStatus(c, status);
    if (c === client) status = next;
  }

  $effect(() => {
    const c = client;
    if (!c) return;
    // The status read here is the previous value, not a dependency of this effect.
    void untrack(() => refresh(c));
    c.googleStatus()
      .then((g) => (account = g.email))
      .catch(() => {});
    // The counters follow what happens on the server (sorting, sync).
    return c.subscribe((e) => {
      if (e.type.startsWith('mail.') || e.type.startsWith('service.')) void refresh(c);
    });
  });

  async function togglePause(c: AcediaClient) {
    const pausing = status.service !== 'pause';
    try {
      await (pausing ? c.pause() : c.resume());
      toast(pausing ? 'Tri en pause : rien n’est rangé seul' : 'Tri repris');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Le tri n’a pas changé', { tone: 'danger' });
    }
    await refresh(c);
  }

  function paired(t: string) {
    saveToken(localStorage, t);
    notice = null;
    token = t;
  }
</script>

{#if authorization && 'error' in authorization}
  <main class="refused lun-acedia" data-monde="acedia">
    <p class="brand">Lun'Acedia</p>
    <p class="error" role="alert">{authorization.error}</p>
    <button type="button" onclick={leaveAuthorization}>Ouvrir Lun'Acedia</button>
  </main>
{:else if client && authorization}
  <Authorize {client} request={authorization.request} />
{:else if client}
  <Shell
    current={screen}
    service={status.service}
    serviceDetail={status.detail}
    counts={status.counts}
    {account}
    ontogglepause={() => togglePause(client)}
  >
    {#key client}
      {#key screen}
        {#if screen === 'mail' || screen === 'a-valider'}
          <!-- À valider shows the proposals in the mail screen until its own screen exists. -->
          <Mailbox
            {client}
            start={screen === 'a-valider' ? 'pending' : 'inbox'}
            onchange={() => refresh(client)}
          />
        {:else if screen === 'agenda' || screen === 'taches'}
          <Agenda {client} />
        {:else if screen === 'journal'}
          <Journal {client} />
        {:else}
          <Settings {client} onSelfRevoked={revokedSelf} />
        {/if}
      {/key}
    {/key}
  </Shell>
{:else}
  <Pair {baseUrl} {notice} authorizing={authorization !== null} onPaired={paired} />
{/if}

<style>
  :global(html, body) {
    margin: 0;
    background: var(--fond);
    color-scheme: dark;
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
    color: var(--danger);
    line-height: 1.5;
  }
</style>
