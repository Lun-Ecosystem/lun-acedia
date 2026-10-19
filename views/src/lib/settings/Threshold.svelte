<script lang="ts">
  import { onMount } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';

  let { client }: { client: AcediaClient } = $props();

  let threshold = $state<number | null>(null);
  let saved = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    client
      .getSettings()
      .then((s) => (threshold = s.threshold))
      .catch((err) => (error = errorText(err)));
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (threshold === null) return;
    error = null;
    saved = false;
    try {
      threshold = (await client.putSettings({ threshold })).threshold;
      saved = true;
    } catch (err) {
      error = errorText(err);
    }
  }
</script>

<section aria-label="Seuil de confiance">
  <h3>Seuil de confiance</h3>
  <p class="hint">
    L’IA range seule un mail quand sa confiance atteint ce seuil ; en dessous, elle propose et attend une
    validation. À 100, rien n’est rangé sans validation. Le spam demande toujours 95 au moins.
  </p>
  <form onsubmit={save}>
    <label
      >Seuil (%)
      <input
        type="number"
        min="0"
        max="100"
        step="1"
        bind:value={threshold}
        required
        oninput={() => (saved = false)}
      />
    </label>
    <button type="submit">Enregistrer</button>
    {#if saved}<span class="ok" role="status">Enregistré</span>{/if}
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
