<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { Settings } from '../types.ts';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import SettingsRow from '../ui/SettingsRow.svelte';
  import Slider from '../ui/Slider.svelte';

  /*
   * The two confidence thresholds: from where the AI files alone, and from where « Tout valider »
   * takes the proposals (never above the first). A scale says what each range becomes.
   */

  interface Props {
    client: AcediaClient;
    settings: Settings;
  }
  let { client, settings = $bindable() }: Props = $props();

  let error = $state<string | null>(null);

  /** Last save asked: an older answer arriving late never replaces a newer value. */
  let seq = 0;

  async function save(patch: Partial<Settings>) {
    const mine = ++seq;
    const before = { ...settings };
    // Lowering the first threshold lowers the second at once, as the server does.
    settings = {
      threshold: patch.threshold ?? settings.threshold,
      bulkThreshold: Math.min(
        patch.bulkThreshold ?? settings.bulkThreshold,
        patch.threshold ?? settings.threshold,
      ),
    };
    error = null;
    try {
      const saved = await client.updateSettings(patch);
      if (mine === seq) settings = saved;
    } catch (err) {
      if (mine !== seq) return;
      error = errorText(err);
      // The server's values, not a copy that may miss a change made meanwhile.
      try {
        settings = await client.getSettings();
      } catch {
        settings = before;
      }
    }
  }

  /** The scale starts at 50 %, lower when « Tout valider » goes below. */
  const low = $derived(Math.min(50, settings.bulkThreshold));
  const summary = $derived(
    `En dessous de ${settings.bulkThreshold} % : un par un ; de ${settings.bulkThreshold} à ${settings.threshold} % : « Tout valider » ; ` +
      (settings.threshold >= 100
        ? 'rien n’est rangé seul'
        : `à partir de ${settings.threshold} % : rangé seul`),
  );
</script>

<div class="seuils">
  <SettingsCard
    title="Seuils de confiance"
    description="Ce que l’IA fait seule, et ce qu’elle laisse à valider."
  >
    <SettingsRow
      label="Ranger seul à partir de"
      hint={'Au-dessus, le mail est rangé sans validation ; l’action s’annule depuis le journal. Le spam demande toujours 95 % au moins.'}
      class="seuil seul"
    >
      <Slider
        label="Ranger seul à partir de"
        value={settings.threshold}
        onchange={(threshold) => save({ threshold })}
      />
    </SettingsRow>
    <SettingsRow
      label="« Tout valider » à partir de"
      hint="Dans la file À valider, le bouton groupé prend les propositions au-dessus de ce seuil."
      class="seuil groupe"
    >
      <Slider
        label="« Tout valider » à partir de"
        max={settings.threshold}
        value={settings.bulkThreshold}
        onchange={(bulkThreshold) => save({ bulkThreshold })}
      />
    </SettingsRow>
    <div class="echelle" role="img" aria-label={summary}>
      {#if settings.bulkThreshold > low}
        <div class="un" style:flex-grow={settings.bulkThreshold - low}>
          <span>{low}&nbsp;%</span><span class="milieu"
            >en dessous de {settings.bulkThreshold}&nbsp;% : un par un</span
          >
        </div>
      {/if}
      {#if settings.threshold > settings.bulkThreshold}
        <div class="tout" style:flex-grow={settings.threshold - settings.bulkThreshold}>
          <span class="milieu">« Tout valider »</span>
        </div>
      {/if}
      {#if settings.threshold < 100}
        <div class="seul" style:flex-grow={100 - settings.threshold}>
          <span class="milieu">seul · 100&nbsp;%</span>
        </div>
      {/if}
    </div>
    {#if error}<p class="erreur" role="alert">{error}</p>{/if}
  </SettingsCard>
</div>

<style>
  .seuils :global(.seuil .curseur) {
    width: 320px;
  }
  .seuils :global(.seuil.seul .plein) {
    background: var(--ok);
  }
  .seuils :global(.seuil.groupe .plein) {
    background: var(--ia);
  }
  .echelle {
    display: flex;
    height: 30px;
    margin: 4px 18px 16px;
    border-radius: var(--r-2);
    overflow: hidden;
    font-size: 11.5px;
  }
  .echelle div {
    display: flex;
    flex-basis: 0;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 8px;
    color: var(--texte);
    white-space: nowrap;
  }
  .milieu {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
  }
  .un {
    background: var(--surface-3);
  }
  .tout {
    background: color-mix(in srgb, var(--ia) 28%, transparent);
  }
  .seul {
    min-width: 64px !important;
    background: color-mix(in srgb, var(--ok) 30%, transparent);
  }
  .erreur {
    margin: 0 18px 14px;
    font-size: 12.5px;
    color: var(--danger);
  }
  @media (max-width: 767.98px) {
    .seuils :global(.seuil .curseur) {
      width: 100%;
    }
    .seuils :global(.seuil .controle) {
      flex: 1 1 100%;
    }
    .echelle {
      margin: 4px 14px 14px;
    }
  }
</style>
