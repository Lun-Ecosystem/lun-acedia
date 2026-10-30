<script lang="ts">
  import { Meter, RadioGroup } from 'bits-ui';
  import { onMount } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import { AGENT_ICONS, agentIcon, agentIdentity, takeIdentity } from '../pina/identity.svelte.ts';
  import type { ModelChoice, ModelOffer, PinaSettings, PinaSettingsView } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import Field from '../ui/Field.svelte';
  import { ICON_STROKE, Plus, Shield } from '../ui/Icon.ts';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import Select from '../ui/Select.svelte';
  import SettingsRow from '../ui/SettingsRow.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import { toast } from '../ui/toasts.svelte.ts';
  import ModelPicker from './ModelPicker.svelte';

  /*
   * Réglages › Agent: who it is (name, icon, tone, character: its voice, never its rights), how it acts (validate first, or at once), her model, what she may spend a day
   * and how long her thread stays, and the standing instructions she reads with each request.
   */

  interface Props {
    client: AcediaClient;
    /** Opens the providers' page (no provider in service yet). */
    onproviders?: (() => void) | undefined;
  }
  let { client, onproviders }: Props = $props();

  /** The UI's bound; the server accepts up to 4000. */
  const MAX_INSTRUCTIONS = 2000;
  const MODES = [
    {
      value: 'validate',
      label: 'Valider avant chaque action',
      hint: 'Chaque écriture arrive en carte : rien n’est fait sans un clic sur Valider.',
    },
    {
      value: 'immediate',
      label: 'Faire tout de suite',
      hint: 'L’agent agit aussitôt ; la carte garde Annuler.',
    },
  ] as const;

  let settings = $state<PinaSettingsView | null>(null);
  let models = $state.raw<ModelOffer[] | null>(null);
  let choice = $state.raw<ModelChoice | null>(null);
  let choosing = $state(false);
  let instructions = $state('');
  let name = $state('');
  let persona = $state('');
  let nameError = $state<string | null>(null);
  const ICONS = Object.entries(AGENT_ICONS).map(([value, { label }]) => ({ value, label }));
  const TONES = [
    { value: 'neutre', label: 'Neutre' },
    { value: 'chaleureux', label: 'Chaleureux' },
    { value: 'concis', label: 'Concis' },
  ];
  const Preview = $derived(agentIcon(settings?.icon ?? 'sparkles'));
  let savingText = $state(false);
  /** Typed values, kept as typed while out of bounds. */
  let days = $state('');
  let cap = $state('');
  let daysError = $state<string | null>(null);
  let capError = $state<string | null>(null);
  let error = $state<string | null>(null);
  const uid = $props.id();

  onMount(() => {
    const fail = (err: unknown) => (error = errorText(err));
    client.getPinaSettings().then((s) => {
      settings = s;
      instructions = s.instructions;
      name = s.name;
      persona = s.persona;
      takeIdentity(s);
      days = String(s.retentionDays);
      cap = String(s.dailyCapUsd);
    }, fail);
    client.getModels('pina').then((m) => (models = m), fail);
    client.getModelChoice().then((c) => (choice = c.pina), fail);
  });

  const selected = $derived(
    choice ? models?.find((m) => m.provider === choice!.provider && m.id === choice!.model) : undefined,
  );

  /** Saves a patch; on refusal, the server's values come back and the reason shows. */
  async function save(patch: Partial<PinaSettings>) {
    error = null;
    try {
      settings = await client.updatePinaSettings(patch);
      takeIdentity(settings);
      toast('Réglage de l’agent enregistré');
      return true;
    } catch (err) {
      error = errorText(err);
      settings = await client.getPinaSettings().catch(() => settings);
      return false;
    }
  }

  function setMode(next: string) {
    if (!settings || next === settings.mode) return;
    settings.mode = next as PinaSettings['mode'];
    void save({ mode: settings.mode });
  }

  /** An integer of 1..365, or a number of 0..50: anything else says so and saves nothing. */
  function saveDays() {
    const n = Number(days);
    daysError = Number.isInteger(n) && n >= 1 && n <= 365 && days !== '' ? null : 'Entre 1 et 365 jours.';
    if (!daysError && n !== settings?.retentionDays) void save({ retentionDays: n });
  }

  function saveCap() {
    const n = Number(String(cap).replace(',', '.'));
    capError = Number.isFinite(n) && n >= 0 && n <= 50 && cap !== '' ? null : 'Entre 0 et 50 $.';
    if (!capError && n !== settings?.dailyCapUsd) void save({ dailyCapUsd: n });
  }

  /** 1 to 40 characters, spaces trimmed: an empty name says so and saves nothing. */
  function saveName() {
    const next = name.trim();
    nameError = next ? null : 'Un nom, de 1 à 40 caractères.';
    if (!nameError && next !== settings?.name) void save({ name: next });
  }

  async function saveInstructions() {
    savingText = true;
    await save({ instructions });
    savingText = false;
  }

  async function choose(next: ModelChoice) {
    const before = choice;
    choice = next;
    choosing = true;
    try {
      choice = await client.setModelChoice('pina', next.provider, next.model);
      toast('Modèle de l’agent enregistré');
    } catch (err) {
      choice = before;
      toast(errorText(err), { tone: 'danger' });
    } finally {
      choosing = false;
    }
  }

  const dollars = (n: number) =>
    `${n.toLocaleString('fr-FR', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} $`;
</script>

{#if error}<p class="erreur" role="alert">{error}</p>{/if}

{#if settings}
  <SettingsCard title="Identité" description="Sa voix, jamais ses droits.">
    {#snippet aside()}
      <span class="apercu" role="img" aria-label={`Aperçu du lanceur : ${settings!.name}`}>
        <Preview size={16} strokeWidth={ICON_STROKE} aria-hidden="true" /><span aria-hidden="true"
          >{settings!.name}</span
        >
      </span>
    {/snippet}
    <div class="bloc">
      <Field label="Nom" error={nameError ?? undefined}>
        <TextInput
          size="petit"
          maxlength={40}
          bind:value={name}
          invalid={nameError !== null}
          onchange={saveName}
        />
      </Field>
    </div>
    <SettingsRow label="Icône">
      <Select
        items={ICONS}
        value={settings.icon}
        aria-label="Icône"
        onchange={(v) => void save({ icon: v as PinaSettings['icon'] })}
      />
    </SettingsRow>
    <SettingsRow label="Ton">
      <Segmented
        options={TONES}
        size="petit"
        label="Ton"
        value={settings.tone}
        onchange={(v) => void save({ tone: v as PinaSettings['tone'] })}
      />
    </SettingsRow>
    <div class="bloc">
      <Field
        label="Contexte du personnage"
        hint="Règle la voix de l’agent, jamais ce qu’il a le droit de faire"
      >
        <textarea
          class="persona"
          aria-label="Contexte du personnage"
          rows="3"
          maxlength={500}
          bind:value={persona}
          onchange={() => persona !== settings!.persona && void save({ persona })}></textarea>
      </Field>
      <span class="compteur">{persona.length} / 500</span>
    </div>
  </SettingsCard>

  <SettingsCard title="Mode" description="Ce que l’agent fait d’une écriture qu’il propose.">
    <div class="modes">
      <RadioGroup.Root
        value={settings.mode}
        onValueChange={setMode}
        aria-label="Mode de l’agent"
        class="options"
      >
        {#each MODES as mode (mode.value)}
          <RadioGroup.Item value={mode.value}>
            {#snippet child({ props, checked })}
              <button {...props} type="button" class={['option', { on: checked }]}>
                <span class="rond" aria-hidden="true"></span>
                <span class="textes">
                  <span class="nom">{mode.label}</span>
                  <span class="aide">{mode.hint}</span>
                </span>
              </button>
            {/snippet}
          </RadioGroup.Item>
        {/each}
      </RadioGroup.Root>
      <p class="toujours">
        <Shield size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        Les suppressions demandent toujours une validation.
      </p>
    </div>
  </SettingsCard>
{/if}

{#if models}
  <SettingsCard
    title="Modèle de l’agent"
    description="Le modèle qui lit les demandes et appelle les actions d’Acedia. Seuls les modèles capables d’appeler des outils sont proposés."
  >
    {#if models.length === 0}
      <SettingsRow label="Aucun fournisseur d’IA en service" hint="L’agent ne répond pas sans modèle.">
        {#if onproviders}
          <Button variant="principal" size="petit" icon={Plus} onclick={onproviders}>Ajouter une clé</Button>
        {/if}
      </SettingsRow>
    {:else}
      <div class="modele">
        {#if !choice}
          <p class="invite">
            Aucun modèle choisi : l’agent ne répond pas tant qu’un modèle n’est pas choisi.
          </p>
        {/if}
        <ModelPicker use="pina" {models} value={choice} onchange={choose} disabled={choosing} />
        {#if selected && !selected.price}
          <p class="sans-prix">Prix inconnu : le plafond quotidien ne compte pas ce que ce modèle coûte.</p>
        {/if}
      </div>
    {/if}
  </SettingsCard>
{/if}

{#if settings}
  <SettingsCard title="Dépense et conservation" description="Ce que l’agent peut coûter, et ce qu’il garde.">
    <SettingsRow label="Plafond quotidien" hint="Atteint, l’agent s’arrête jusqu’au lendemain.">
      {#snippet children({ labelId })}
        <div class="nombre">
          <TextInput
            type="number"
            size="petit"
            min="0"
            max="50"
            step="0.5"
            inputmode="decimal"
            suffix="$"
            bind:value={cap}
            invalid={capError !== null}
            aria-labelledby={labelId}
            aria-describedby={capError ? `${uid}-cap` : undefined}
            onchange={saveCap}
          />
          {#if capError}<span class="borne" id="{uid}-cap">{capError}</span>{/if}
        </div>
      {/snippet}
    </SettingsRow>
    <SettingsRow
      label="Dépense du jour"
      hint="{dollars(settings.spentTodayUsd)} sur {dollars(settings.dailyCapUsd)}"
    >
      <Meter.Root
        value={Math.min(settings.spentTodayUsd, settings.dailyCapUsd)}
        max={settings.dailyCapUsd || 1}
        aria-label="Dépense du jour"
        aria-valuetext="{dollars(settings.spentTodayUsd)} sur {dollars(settings.dailyCapUsd)}"
      >
        {#snippet child({ props })}
          <div {...props} class={['jauge', { plein: settings!.spentTodayUsd >= settings!.dailyCapUsd }]}>
            <span
              class="rempli"
              style:width="{settings!.dailyCapUsd
                ? Math.min(100, (settings!.spentTodayUsd / settings!.dailyCapUsd) * 100)
                : 100}%"
            ></span>
          </div>
        {/snippet}
      </Meter.Root>
    </SettingsRow>
    <SettingsRow label="Conservation du fil" hint="Les jours plus anciens sont effacés.">
      {#snippet children({ labelId })}
        <div class="nombre">
          <TextInput
            type="number"
            size="petit"
            min="1"
            max="365"
            step="1"
            inputmode="numeric"
            suffix="jours"
            bind:value={days}
            invalid={daysError !== null}
            aria-labelledby={labelId}
            aria-describedby={daysError ? `${uid}-jours` : undefined}
            onchange={saveDays}
          />
          {#if daysError}<span class="borne" id="{uid}-jours">{daysError}</span>{/if}
        </div>
      {/snippet}
    </SettingsRow>
  </SettingsCard>

  <SettingsCard
    title="Consignes"
    description="Ce que l’agent garde en tête à chaque demande : une signature, des habitudes."
  >
    <div class="consignes">
      <textarea
        bind:value={instructions}
        maxlength={MAX_INSTRUCTIONS}
        rows="5"
        aria-label="Consignes"
        aria-describedby="{uid}-compte"
        placeholder="Par exemple : signer les mails « Natsume », rester bref."></textarea>
      <div class="pied">
        <span class="compte" id="{uid}-compte">{instructions.length} / {MAX_INSTRUCTIONS}</span>
        <Button
          variant="secondaire"
          size="petit"
          loading={savingText}
          disabled={instructions === settings.instructions}
          onclick={saveInstructions}>Enregistrer les consignes</Button
        >
      </div>
    </div>
  </SettingsCard>
{/if}

<style>
  .bloc {
    position: relative;
    padding: 14px 18px;
    border-bottom: 1px solid var(--bordure);
  }
  .compteur {
    position: absolute;
    top: 14px;
    right: 18px;
    font-size: 12px;
    color: var(--texte-3);
    font-variant-numeric: tabular-nums;
  }
  .apercu {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 180px;
    color: var(--texte);
    font-size: 13.5px;
  }
  .apercu :global(svg) {
    flex: none;
    color: var(--ia);
  }
  .apercu span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .modes {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 18px 16px;
  }
  .modes :global(.options) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .option {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
    background: var(--surface-2);
    color: var(--texte);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      border-color 120ms ease,
      background-color 120ms ease;
  }
  .option:hover {
    border-color: color-mix(in srgb, var(--texte-2) 40%, transparent);
    background: var(--surface-3);
  }
  .option.on {
    border-color: var(--ia-bord);
    background: var(--ia-doux);
  }
  .option:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }
  .rond {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    border: 1.5px solid var(--bordure-forte);
    border-radius: 50%;
    box-sizing: border-box;
  }
  .on .rond {
    border: 5px solid var(--ia);
  }
  .textes {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .nom {
    font: 400 14px/1.4 var(--sans);
  }
  .aide {
    font-size: 12.5px;
    color: var(--texte-3);
  }
  .toujours {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 12.5px;
    color: var(--texte-2);
  }
  .toujours :global(svg) {
    flex: none;
    color: var(--ia);
  }
  .modele {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 18px 16px;
  }
  .invite,
  .sans-prix {
    margin: 0;
    font-size: 13px;
    color: var(--texte-2);
  }
  .sans-prix {
    color: var(--attention);
  }
  .nombre {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .nombre :global(.entree) {
    width: 132px;
  }
  .borne {
    font-size: 12px;
    color: var(--danger);
  }
  .jauge {
    position: relative;
    width: 220px;
    height: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-3);
  }
  .rempli {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--ia);
  }
  .plein .rempli {
    background: var(--attention);
  }
  .consignes {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 18px 16px;
  }
  textarea {
    min-height: 120px;
    padding: 12px 14px;
    resize: vertical;
    background: var(--surface-2);
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
    color: var(--texte);
    font: 300 14px/1.6 var(--sans);
  }
  textarea::placeholder {
    color: var(--texte-3);
  }
  textarea:focus-visible {
    border-color: var(--accent-texte);
    outline: none;
    box-shadow: 0 0 0 3px var(--accent-doux);
  }
  .pied {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .compte {
    font-size: 12px;
    color: var(--texte-3);
    font-variant-numeric: tabular-nums;
  }
  .erreur {
    margin: 0;
    font-size: 13px;
    color: var(--danger);
  }
  @media (max-width: 767.98px) {
    .modes {
      padding: 14px;
    }
    .modes :global(.options) {
      grid-template-columns: 1fr;
    }
    .modele,
    .consignes {
      padding: 14px;
    }
    /* The row's control does not stretch: a fixed width, or the meter would vanish. */
    .jauge {
      width: 132px;
    }
    .nombre {
      align-items: flex-start;
    }
  }
</style>
