<script lang="ts">
  import { onMount } from 'svelte';
  import type { AcediaClient, AnthropicKeyStatus } from '../client.ts';
  import { errorText } from '../mail/format.ts';

  let { client }: { client: AcediaClient } = $props();

  let status = $state<AnthropicKeyStatus | null>(null);
  let key = $state('');
  let expires = $state('');
  let pending = $state(false);
  let saved = $state(false);
  let error = $state<string | null>(null);

  const STATES: Record<AnthropicKeyStatus['state'], string> = {
    ok: 'En service',
    refused: 'Refusée',
    credit: 'Crédit épuisé',
    absent: 'Absente : seules les règles trient',
  };

  onMount(() => {
    client
      .getAnthropicKey()
      .then((s) => (status = s))
      .catch((err) => (error = errorText(err)));
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!key.trim() || pending) return;
    pending = true;
    saved = false;
    error = null;
    try {
      // The check with Anthropic can take several seconds; on refusal nothing changes.
      status = await client.saveAnthropicKey(key.trim(), expires || undefined);
      key = '';
      expires = '';
      saved = true;
    } catch (err) {
      error = errorText(err);
    } finally {
      pending = false;
    }
  }

  /** `AAAA-MM-JJ` as `JJ/MM/AAAA`, without going through a time zone. */
  const day = (iso: string) => iso.split('-').reverse().join('/');
</script>

<section class="anthropic-key" aria-label="Clé Anthropic">
  <h3>Clé Anthropic</h3>
  <p class="hint">
    Sert au tri par l’IA. Une nouvelle clé est vérifiée auprès d’Anthropic avant d’être enregistrée, puis sert
    dès le mail suivant, sans redémarrage.
  </p>

  {#if status}
    <div class="current" data-state={status.state}>
      <p class="state"><span class="dot" aria-hidden="true"></span><span>{STATES[status.state]}</span></p>
      {#if status.last4}<p class="meta">Se termine par {status.last4}</p>{/if}
      {#if status.expires}<p class="meta">Échéance déclarée : {day(status.expires)}</p>{/if}
    </div>
  {/if}

  <form class="replace" onsubmit={save}>
    <label class="field"
      >Nouvelle clé
      <input
        type="password"
        autocomplete="off"
        spellcheck="false"
        autocapitalize="off"
        bind:value={key}
        oninput={() => (saved = false)}
        disabled={pending}
      />
    </label>
    <label class="field date"
      >Échéance (facultatif)
      <input type="date" bind:value={expires} disabled={pending} />
    </label>
    <button type="submit" class="primary" disabled={pending || !key.trim()} aria-busy={pending}
      >Vérifier et enregistrer</button
    >
  </form>
  <p class="hint">Un avertissement est émis 14 jours puis 3 jours avant l’échéance déclarée.</p>

  {#if pending}<p class="ok" role="status">Vérification auprès d’Anthropic…</p>{/if}
  {#if saved}<p class="ok" role="status">Clé vérifiée et enregistrée.</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .current {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.2rem 1.2rem;
    border: 1px solid var(--bordure);
    border-left: 3px solid var(--lune);
    border-radius: var(--rayon);
    padding: 0.55rem 0.75rem;
    margin: 0.4rem 0 0.8rem;
  }
  .current p {
    margin: 0;
  }
  .current[data-state='ok'] {
    border-left-color: var(--lavis);
  }
  .current[data-state='refused'],
  .current[data-state='credit'] {
    border-left-color: var(--erreur);
  }
  .state {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-weight: 400;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    border: 1px solid var(--lune);
  }
  [data-state='ok'] .dot {
    background: var(--lavis);
    border-color: var(--lavis);
  }
  [data-state='refused'] .dot,
  [data-state='credit'] .dot {
    background: var(--erreur);
    border-color: var(--erreur);
  }
  [data-state='refused'] .state,
  [data-state='credit'] .state {
    color: var(--erreur);
  }
  .meta {
    font-size: 0.85rem;
    color: var(--lune);
  }
  .replace {
    align-items: flex-end;
  }
  .replace .field {
    flex-direction: column;
    align-items: stretch;
    gap: 0.25rem;
  }
  .replace .field:first-child {
    flex: 1 1 18rem;
  }
  .replace .field input {
    min-width: 0;
  }
  .replace .primary {
    padding: 0.4rem 1rem;
    color: var(--ivoire);
    background: var(--monde-accent);
    border-color: var(--monde-accent);
    font-weight: 400;
  }
  .replace .primary:hover:not(:disabled) {
    border-color: var(--lavis);
  }
  .replace .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .replace .primary[aria-busy='true'] {
    cursor: progress;
  }
</style>
