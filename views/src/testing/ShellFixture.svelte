<script lang="ts">
  import type { AcediaClient } from '../lib/client.ts';
  import Mailbox from '../lib/mail/Mailbox.svelte';
  import Pending from '../lib/mail/Pending.svelte';
  import { provideShell, type ScreenParts } from '../lib/ui/shell.ts';

  /** A screen inside a shell, for what only a shell shows or gives: its part of the rail, the search. */
  let {
    client,
    screen = 'mail',
    onparts,
  }: {
    client: AcediaClient;
    screen?: 'mail' | 'pending';
    onparts?: (parts: ScreenParts | null) => void;
  } = $props();

  let parts = $state<ScreenParts | null>(null);
  provideShell((p) => {
    parts = p;
    onparts?.(p);
  });
</script>

<nav aria-label="Rail">{@render parts?.rail?.()}</nav>
{#if screen === 'mail'}<Mailbox {client} />{:else}<Pending {client} />{/if}
