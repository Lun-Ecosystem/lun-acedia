<script lang="ts">
  import { pair } from './session.ts';

  let {
    baseUrl,
    notice = null,
    onPaired,
  }: { baseUrl: string; notice?: string | null; onPaired: (token: string) => void } = $props();

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
  <h1>Lun'Acedia</h1>
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  <p>
    Entre le code d’appairage à 6 chiffres : au premier lancement il est dans les journaux du serveur, ensuite
    dans Réglages, Appairage, sur un appareil déjà relié.
  </p>
  <form onsubmit={submit}>
    <label
      >Code d’appairage
      <input
        bind:value={code}
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]{6}"
        maxlength="6"
        required
      />
    </label>
    <button type="submit" disabled={busy}>Relier cet appareil</button>
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
  p {
    color: var(--lune);
    line-height: 1.5;
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
