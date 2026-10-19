<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';

  let { client }: { client: AcediaClient } = $props();

  let code = $state<{ code: string; expiresAt: string } | null>(null);
  let error = $state<string | null>(null);

  async function generate() {
    error = null;
    try {
      code = await client.createPairingCode();
    } catch (err) {
      error = errorText(err);
    }
  }

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
</script>

<section aria-label="Appairage">
  <h3>Appairage</h3>
  <p class="hint">Un code à usage unique pour relier un nouvel appareil ou le core Lun'Anima à Lun'Acedia.</p>
  <button type="button" onclick={generate}>Générer un code</button>
  {#if code}
    <p class="code">{code.code}</p>
    <p class="hint">Expire à {time(code.expiresAt)}</p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .code {
    margin: 0.75rem 0 0.25rem;
    font-family: var(--serif);
    font-size: 2.2rem;
    letter-spacing: 0.3em;
  }
</style>
