<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { ProviderId, ProviderView } from '../types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import Field from '../ui/Field.svelte';
  import { Calendar, ICON_STROKE, Plus } from '../ui/Icon.ts';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import SettingsRow from '../ui/SettingsRow.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import { toast } from '../ui/toasts.svelte.ts';
  import type { Tone } from '../ui/types.ts';

  /*
   * One card per AI provider: its state first, then its key by its last 4 characters only. Adding or
   * replacing opens a window (the check with the provider can take seconds); removing asks first.
   */

  interface Props {
    client: AcediaClient;
    /** `null`: the keys could not be read. */
    providers: ProviderView[] | null;
    /** The provider whose key window is open, from here or from the banner of a refused key. */
    editing?: ProviderId | null | undefined;
  }
  let { client, providers = $bindable(), editing = $bindable(null) }: Props = $props();

  const uid = $props.id();
  let key = $state('');
  let expires = $state('');
  let baseUrl = $state('');
  let pending = $state(false);
  let error = $state<string | undefined>();
  let removing = $state<ProviderView | null>(null);
  let retrying = $state(false);

  const BADGE: Record<ProviderView['state'], { text: string; tone: Tone }> = {
    ok: { text: 'En service', tone: 'ok' },
    refused: { text: 'Refusée', tone: 'danger' },
    credit: { text: 'Crédit épuisé', tone: 'attention' },
    absent: { text: 'Sans clé', tone: 'neutre' },
  };
  const DESCRIPTION: Record<ProviderId, string> = {
    anthropic: 'Les modèles Claude.',
    openai: 'Les modèles GPT.',
    google: 'Les modèles Gemini.',
    mistral: 'Les modèles Mistral.',
    custom: 'Ollama en local, OpenRouter ou tout point d’accès compatible OpenAI.',
  };
  /** « auprès d’Anthropic », « auprès de Mistral »… */
  const WITH: Record<ProviderId, string> = {
    anthropic: 'd’Anthropic',
    openai: 'd’OpenAI',
    google: 'de Google',
    mistral: 'de Mistral',
    custom: 'du point d’accès',
  };

  const current = $derived(providers?.find((p) => p.id === editing));
  const ready = $derived(Boolean(key.trim()) && (editing !== 'custom' || Boolean(baseUrl.trim())));

  $effect(() => {
    if (!editing) {
      key = '';
      expires = '';
      error = undefined;
    } else baseUrl = current?.baseUrl ?? '';
  });

  const put = (view: ProviderView) => {
    providers = providers?.map((p) => (p.id === view.id ? view : p)) ?? null;
  };

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!editing || !ready || pending) return;
    pending = true;
    error = undefined;
    try {
      // On refusal nothing changes on the server: the window stays, with the reason.
      put(
        await client.saveProviderKey(editing, {
          key: key.trim(),
          ...(expires ? { expires } : {}),
          ...(editing === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
        }),
      );
      editing = null;
      toast('Clé vérifiée et enregistrée');
    } catch (err) {
      error = errorText(err);
    } finally {
      pending = false;
    }
  }

  async function retry() {
    retrying = true;
    try {
      providers = await client.getProviders();
    } catch (err) {
      toast(errorText(err), { tone: 'danger' });
    } finally {
      retrying = false;
    }
  }

  async function remove() {
    const { id, label } = removing!;
    put(await client.removeProviderKey(id));
    toast(`Clé ${label} retirée`);
  }

  /** `AAAA-MM-JJ` as « 12 mars 2027 », without going through the local time zone. */
  const day = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
</script>

{#if providers}
  {#each providers as p (p.id)}
    <SettingsCard title={p.label} description={DESCRIPTION[p.id]} class="fournisseur">
      {#snippet aside()}
        {#if p.state === 'absent'}
          <Button variant="principal" size="petit" icon={Plus} onclick={() => (editing = p.id)}
            >Ajouter une clé</Button
          >
        {:else}
          <Badge tone={BADGE[p.state].tone} dot>{BADGE[p.state].text}</Badge>
        {/if}
      {/snippet}
      {#if p.state !== 'absent'}
        <SettingsRow label={p.source === 'env' ? 'Clé du fichier .env' : 'Clé enregistrée'}>
          {#snippet hint()}
            {#if p.last4}Se termine par <span class="mono">{p.last4}</span>{:else}Jamais affichée{/if}
          {/snippet}
          <Button size="petit" onclick={() => (editing = p.id)}>Remplacer…</Button>
          {#if p.source !== 'env'}
            <Button variant="fantome" size="petit" class="retirer" onclick={() => (removing = p)}
              >Retirer</Button
            >
          {/if}
        </SettingsRow>
        {#if p.baseUrl}
          <SettingsRow label="Adresse">
            <span class="mono adresse">{p.baseUrl}</span>
          </SettingsRow>
        {/if}
        <SettingsRow label="Échéance déclarée" hint="Avertissement 14 jours puis 3 jours avant.">
          <span class="puce">
            <Calendar size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {p.expires ? day(p.expires) : 'Aucune'}
          </span>
        </SettingsRow>
      {/if}
    </SettingsCard>
  {/each}
{:else}
  <SettingsCard title="Fournisseurs d’IA">
    <SettingsRow label="État des clés inconnu" hint="Les clés n’ont pas pu être lues.">
      <Button size="petit" loading={retrying} onclick={retry}>Réessayer</Button>
    </SettingsRow>
  </SettingsCard>
{/if}

<!-- A check in progress keeps the window open: its answer, a refusal included, must be seen. -->
<Dialog
  bind:open={
    () => Boolean(editing),
    (next) => {
      if (!pending && !next) editing = null;
    }
  }
  title={current && current.state !== 'absent' ? 'Remplacer la clé' : 'Ajouter une clé'}
  description={editing
    ? `${current?.label ?? ''} : vérifiée auprès ${WITH[editing]} avant d’être enregistrée, elle sert dès l’appel suivant.`
    : undefined}
>
  {#snippet children()}
    <form id="{uid}-cle" class="champs" onsubmit={save}>
      {#if editing === 'custom'}
        <Field label="Adresse" hint="Par exemple http://localhost:11434/v1 pour Ollama.">
          <TextInput
            type="url"
            autocomplete="off"
            spellcheck="false"
            autocapitalize="off"
            bind:value={baseUrl}
            disabled={pending}
          />
        </Field>
      {/if}
      <Field label="Nouvelle clé" {error}>
        <TextInput
          type="password"
          autocomplete="off"
          spellcheck="false"
          autocapitalize="off"
          bind:value={key}
          disabled={pending}
        />
      </Field>
      <Field label="Échéance (facultatif)" hint="Avertissement 14 jours puis 3 jours avant.">
        <TextInput type="date" bind:value={expires} disabled={pending} />
      </Field>
      {#if pending && editing}<p class="attente" role="status">Vérification auprès {WITH[editing]}…</p>{/if}
    </form>
  {/snippet}
  {#snippet footer({ close })}
    <Button onclick={close} disabled={pending}>Annuler</Button>
    <Button type="submit" form="{uid}-cle" variant="principal" loading={pending} disabled={!ready}
      >Vérifier et enregistrer</Button
    >
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={() => Boolean(removing), (next) => !next && (removing = null)}
  title="Retirer la clé {removing?.label ?? ''} ?"
  message="Ce qui l’utilise s’arrête ; les règles du tri continuent de s’appliquer. Une nouvelle clé peut être ajoutée à tout moment."
  confirmLabel="Retirer la clé"
  onconfirm={remove}
/>

<style>
  .mono {
    font:
      400 13px ui-monospace,
      Consolas,
      monospace;
    color: var(--texte-2);
  }
  .adresse {
    overflow-wrap: anywhere;
  }
  .puce {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-1);
    background: var(--surface-2);
    font-size: 13px;
    color: var(--texte);
    white-space: nowrap;
  }
  .puce :global(svg) {
    color: var(--texte-3);
  }
  :global(.fournisseur) :global(.btn.retirer) {
    color: var(--danger);
  }
  .champs {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .attente {
    margin: 0;
    font-size: 12.5px;
    color: var(--texte-2);
  }
</style>
