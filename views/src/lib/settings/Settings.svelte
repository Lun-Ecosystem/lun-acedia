<script lang="ts">
  import { onMount } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { LabelView } from '../types.ts';
  import AnthropicKey from './AnthropicKey.svelte';
  import Boxes from './Boxes.svelte';
  import Devices from './Devices.svelte';
  import GoogleAccount from './GoogleAccount.svelte';
  import Rules from './Rules.svelte';
  import Threshold from './Threshold.svelte';

  let {
    client,
    onSelfRevoked,
  }: {
    client: AcediaClient;
    /** Called once this browser revoked its own access (Appareils et applications). */
    onSelfRevoked?: (() => void) | undefined;
  } = $props();

  let labels = $state<LabelView[]>([]);
  let error = $state<string | null>(null);

  onMount(() => {
    client
      .listLabels()
      .then((l) => (labels = l))
      .catch((err) => (error = errorText(err)));
  });
</script>

<div class="settings lun-acedia">
  <h2>Réglages</h2>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <GoogleAccount {client} />
  <Boxes {client} bind:labels />
  <Rules {client} {labels} />
  <Threshold {client} />
  <AnthropicKey {client} />
  <Devices {client} {onSelfRevoked} />
</div>

<style>
  .settings {
    max-width: 52rem;
    padding: 1rem 1.25rem 2rem;
    overflow-y: auto;
    height: 100%;
    box-sizing: border-box;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.8rem;
  }
  .settings :global(section) {
    padding: 1rem 0;
    border-bottom: 1px solid var(--bordure);
  }
  .settings :global(h3) {
    margin: 0 0 0.4rem;
    font-family: var(--serif);
    font-weight: 500;
    font-size: 1.3rem;
  }
  .settings :global(.hint) {
    margin: 0.25rem 0 0.6rem;
    font-size: 0.85rem;
    color: var(--lune);
  }
  .settings :global(ul) {
    list-style: none;
    margin: 0 0 0.6rem;
    padding: 0;
  }
  .settings :global(li) {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.3rem 0;
  }
  .settings :global(li > span) {
    flex: 1;
  }
  .settings :global(form) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.4rem 0;
  }
  .settings :global(label) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--lune);
  }
  .settings :global(.error) {
    color: var(--erreur);
  }
  .settings :global(.ok) {
    font-size: 0.85rem;
    color: var(--lavis);
  }
</style>
