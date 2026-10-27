<script module lang="ts">
  import type { ModelOffer, ProviderId } from '../types.ts';

  export const PROVIDER_LABELS: Record<ProviderId, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google Gemini',
    mistral: 'Mistral',
    custom: 'Point d’accès compatible',
  };

  const amount = (n: number) =>
    n.toLocaleString('fr-FR', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

  /** « Anthropic · 0,10 / 0,50 $ par M jetons », or « prix inconnu »: never a price of 0. */
  export const priceLine = (m: ModelOffer) =>
    `${PROVIDER_LABELS[m.provider]} · ${
      m.price ? `${amount(m.price.input)} / ${amount(m.price.output)} $ par M jetons` : 'prix inconnu'
    }`;
</script>

<script lang="ts">
  import type { ModelChoice } from '../types.ts';
  import Badge from '../ui/Badge.svelte';
  import Select from '../ui/Select.svelte';

  /*
   * The model of a use, among the models of the configured providers: each entry says its provider,
   * its input / output price per million tokens and its cost marker (€, €€, €€€).
   */

  interface Props {
    use: 'triage' | 'pina';
    models: ModelOffer[];
    value: ModelChoice | null;
    onchange: (choice: ModelChoice) => void;
    disabled?: boolean | undefined;
  }
  let { use, models, value, onchange, disabled = false }: Props = $props();

  const keyOf = (provider: string, id: string) => `${provider}/${id}`;
  const items = $derived(
    models.map((m) => ({
      value: keyOf(m.provider, m.id),
      label: m.label,
      hint: m.tier ? `${priceLine(m)} · ${m.tier}` : priceLine(m),
    })),
  );
  const selected = $derived(
    value ? models.find((m) => m.provider === value.provider && m.id === value.model) : undefined,
  );
</script>

<div class="choix">
  <!-- Named by its use, the card around it carries the visible title. -->
  <Select
    {items}
    {disabled}
    aria-label={use === 'triage' ? 'Modèle du tri' : 'Modèle de Pina'}
    placeholder="Choisir un modèle…"
    value={value ? keyOf(value.provider, value.model) : ''}
    onchange={(next) => {
      const m = models.find((x) => keyOf(x.provider, x.id) === next);
      if (m) onchange({ provider: m.provider, model: m.id });
    }}
  />
  {#if selected}
    <p class="detail">
      <span>{priceLine(selected)}</span>
      {#if selected.tier}<Badge tone="neutre">{selected.tier}</Badge>{/if}
    </p>
  {/if}
</div>

<style>
  .choix {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: min(320px, 100%);
  }
  .detail {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 12.5px;
    color: var(--texte-2);
  }
</style>
