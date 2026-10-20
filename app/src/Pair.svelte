<script lang="ts">
  import { pair } from './session.ts';

  let {
    baseUrl,
    notice = null,
    authorizing = false,
    onPaired,
  }: {
    baseUrl: string;
    notice?: string | null;
    /** An app is waiting for an authorization: the page resumes it once this browser is paired. */
    authorizing?: boolean;
    onPaired: (token: string) => void;
  } = $props();

  let code = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      onPaired(await pair(baseUrl, code));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<main class="pair lun-acedia">
  {#if authorizing}
    <p class="brand">Lun'Acedia</p>
    <h1 class="step">Confirmer depuis le serveur</h1>
  {:else}
    <h1>Lun'Acedia</h1>
  {/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if authorizing}
    <p>
      Lun'Acedia ne connaît pas ce navigateur. Saisir le code donné par <code>npm run pair-code</code> sur la machine
      qui héberge Lun'Acedia.
    </p>
  {:else}
    <p>
      Saisir le code d’appairage à 6 chiffres, donné par <code>npm run pair-code</code> sur la machine qui héberge
      Lun'Acedia, ou dans Réglages, Appareils et applications, sur un appareil déjà relié.
    </p>
  {/if}
  <form onsubmit={submit}>
    <label
      >{authorizing ? 'Code à 6 chiffres' : 'Code d’appairage'}
      <input
        bind:value={code}
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern={' *[0-9]{6} *'}
        required
      />
    </label>
    <button type="submit" disabled={busy}>{authorizing ? 'Continuer' : 'Relier cet appareil'}</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</main>

<style>
  .pair {
    max-width: 26rem;
    margin: 0 auto;
    padding: 18vh 1rem 2rem;
    min-height: 100dvh;
    box-sizing: border-box;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 2.6rem;
    margin: 0 0 1rem;
  }
  .brand {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.35rem;
    margin: 0 0 1.25rem;
  }
  h1.step {
    font-size: 2rem;
    line-height: 1.2;
  }
  p {
    color: var(--lune);
    line-height: 1.5;
  }
  code {
    font-family: inherit;
    font-weight: 400;
    color: var(--ivoire);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    margin-top: 1.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--lune);
  }
  input {
    font-family: var(--serif);
    font-size: 2rem;
    letter-spacing: 0.3em;
    text-align: center;
  }
  .notice {
    color: var(--lavis);
  }
  .error {
    color: #e3a0a0;
  }
</style>
