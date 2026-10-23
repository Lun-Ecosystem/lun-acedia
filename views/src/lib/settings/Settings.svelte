<script lang="ts">
  import { onMount } from 'svelte';
  import type { AcediaClient, AnthropicKeyStatus, LinkedClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { GoogleStatus, LabelView, Rule, Settings } from '../types.ts';
  import Badge from '../ui/Badge.svelte';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import {
    ArrowLeft,
    ChevronRight,
    Folder,
    ICON_STROKE,
    Mail,
    Monitor,
    Pause,
    Play,
    Sparkles,
    type IconComponent,
  } from '../ui/Icon.ts';
  import NavGroup from '../ui/NavGroup.svelte';
  import NavLink from '../ui/NavLink.svelte';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import { toast } from '../ui/toasts.svelte.ts';
  import type { Tone } from '../ui/types.ts';
  import AnthropicKey from './AnthropicKey.svelte';
  import Boxes from './Boxes.svelte';
  import Devices from './Devices.svelte';
  import GoogleAccount from './GoogleAccount.svelte';
  import Rules from './Rules.svelte';
  import Threshold from './Threshold.svelte';

  /*
   * Settings (plate 06): a column of themes, one page per theme with its cards centered. A problem
   * shows as a banner on top of the page concerned. On a phone, the column is the entry list and a
   * theme opens full screen.
   */

  let {
    client,
    onSelfRevoked,
    onchange,
  }: {
    client: AcediaClient;
    /** Called once this browser revoked its own access (Appareils et applications). */
    onSelfRevoked?: (() => void) | undefined;
    /** Something the service state depends on changed (the pause, the key). */
    onchange?: (() => void) | undefined;
  } = $props();

  type Theme = 'google' | 'appareils' | 'tri' | 'boites';
  interface Page {
    id: Theme;
    label: string;
    icon: IconComponent;
    group: string;
    description: string;
  }
  const PAGES: Page[] = [
    {
      id: 'google',
      label: 'Compte Google',
      icon: Mail,
      group: 'Compte',
      description: "Le compte dont Lun'Acedia lit les mails, l’agenda et les tâches.",
    },
    {
      id: 'appareils',
      label: 'Appareils et applications',
      icon: Monitor,
      group: 'Compte',
      description: "Ce qui a accès à Lun'Acedia.",
    },
    {
      id: 'tri',
      label: 'Tri par l’IA',
      icon: Sparkles,
      group: 'Tri',
      description:
        'La clé qui fait tourner le tri, et le niveau de confiance à partir duquel l’IA agit seule.',
    },
    {
      id: 'boites',
      label: 'Boîtes et règles',
      icon: Folder,
      group: 'Tri',
      description: 'Où l’IA peut ranger, et ce qui est rangé avant même de lui demander.',
    },
  ];
  const GROUPS = ['Compte', 'Tri'];

  let theme = $state<Theme>('tri');
  /** On a phone: a theme is open (else the list of themes shows). */
  let opened = $state(false);
  const page = $derived(PAGES.find((p) => p.id === theme)!);

  let labels = $state<LabelView[]>([]);
  let rules = $state<Rule[]>([]);
  let key = $state<AnthropicKeyStatus | null>(null);
  let google = $state<GoogleStatus | null>(null);
  let clients = $state<LinkedClient[]>([]);
  let settings = $state<Settings | null>(null);
  let paused = $state(false);
  let replacing = $state(false);
  let pausing = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    const fail = (err: unknown) => (error = errorText(err));
    client.listLabels().then((l) => (labels = l), fail);
    client.listRules().then((r) => (rules = r), fail);
    client.getAnthropicKey().then((k) => (key = k), fail);
    client.googleStatus().then((g) => (google = g), fail);
    client.listClients().then((c) => (clients = c), fail);
    client.getSettings().then((s) => (settings = s), fail);
    client.health().then((h) => (paused = h.status === 'paused' || h.paused === true), fail);
  });

  const keyProblem = $derived(key?.state === 'refused' || key?.state === 'credit');
  const KEY_BADGE: Record<AnthropicKeyStatus['state'], { text: string; tone: Tone }> = {
    ok: { text: 'En service', tone: 'ok' },
    refused: { text: 'Clé refusée', tone: 'danger' },
    credit: { text: 'Crédit épuisé', tone: 'attention' },
    absent: { text: 'Sans clé', tone: 'neutre' },
  };
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
  /** What the list of themes says of each, on a phone. */
  const summary = $derived<Record<Theme, string>>({
    google: google ? (google.connected ? 'Connecté' : 'Non connecté') : '',
    appareils: String(clients.length),
    tri: '',
    boites: `${plural(labels.filter((l) => l.role === 'box').length, 'boîte')} · ${plural(rules.length, 'règle')}`,
  });

  function open(next: Theme) {
    return (event: MouseEvent) => {
      event.preventDefault();
      theme = next;
      opened = true;
    };
  }

  function replaceKey() {
    theme = 'tri';
    opened = true;
    replacing = true;
  }

  async function togglePause() {
    pausing = true;
    const next = !paused;
    try {
      await (next ? client.pause() : client.resume());
      paused = next;
      toast(next ? 'Tri en pause : rien n’est rangé seul' : 'Tri repris');
      onchange?.();
    } catch (err) {
      toast(errorText(err), { tone: 'danger' });
    } finally {
      pausing = false;
    }
  }
</script>

<div class={['reglages', 'lun-acedia', { ouvert: opened }]} data-monde="acedia">
  <nav class="themes" aria-label="Thèmes des réglages">
    <h1>Réglages</h1>
    {#each GROUPS as group (group)}
      <NavGroup title={group}>
        <div class="bloc">
          {#each PAGES.filter((p) => p.group === group) as p (p.id)}
            <div class="theme">
              <NavLink href="#" label={p.label} icon={p.icon} current={theme === p.id} onclick={open(p.id)} />
              {#if p.id === 'tri' && keyProblem}<span class="alerte" aria-hidden="true"></span>{/if}
              <span class="resume" aria-hidden="true">
                {#if p.id === 'tri'}
                  {#if key}<Badge tone={KEY_BADGE[key.state].tone}>{KEY_BADGE[key.state].text}</Badge>{/if}
                {:else}
                  {summary[p.id]}
                {/if}
                <ChevronRight size={14} strokeWidth={ICON_STROKE} />
              </span>
            </div>
          {/each}
        </div>
      </NavGroup>
    {/each}
  </nav>

  <div class="contenu">
    <div class="colonne">
      <Button variant="fantome" size="petit" icon={ArrowLeft} class="retour" onclick={() => (opened = false)}
        >Réglages</Button
      >
      {#if keyProblem && (theme === 'tri' || theme === 'boites')}
        <Banner
          title={key?.state === 'credit'
            ? 'Crédit Anthropic épuisé : le tri par l’IA est en pause.'
            : 'Clé Anthropic refusée : le tri par l’IA est en pause.'}
        >
          Les règles continuent de s’appliquer. Les nouveaux mails restent en réception.
          {#snippet action()}
            <Button variant="principal" size="petit" onclick={replaceKey}>Remplacer la clé</Button>
          {/snippet}
        </Banner>
      {/if}
      {#if error}<p class="erreur" role="alert">{error}</p>{/if}

      <header class="tete">
        <small>{page.group}</small>
        <h2>{page.label}</h2>
        <p>{page.description}</p>
      </header>

      {#if theme === 'google'}
        <GoogleAccount {client} bind:status={google} />
      {:else if theme === 'appareils'}
        <Devices {client} bind:clients {onSelfRevoked} />
      {:else if theme === 'tri'}
        {#if key}
          <!-- A new or removed key changes the service state shown around the screen. -->
          <AnthropicKey
            {client}
            bind:status={
              () => key,
              (next) => {
                key = next;
                onchange?.();
              }
            }
            bind:replacing
          />
        {/if}
        {#if settings}<Threshold {client} bind:settings />{/if}
        <SettingsCard
          title={paused ? 'Tri en pause' : 'Tri en cours'}
          description={paused
            ? 'Rien n’est rangé seul ; les nouveaux mails restent en réception jusqu’à la reprise.'
            : 'Mettre en pause arrête le tri des nouveaux mails, rien d’autre.'}
        >
          {#snippet aside()}
            <Button
              variant={paused ? 'principal' : 'secondaire'}
              size="petit"
              icon={paused ? Play : Pause}
              loading={pausing}
              onclick={togglePause}>{paused ? 'Reprendre le tri' : 'Mettre en pause'}</Button
            >
          {/snippet}
        </SettingsCard>
      {:else}
        <Boxes {client} bind:labels />
        <Rules {client} {labels} bind:rules />
      {/if}
    </div>
  </div>
</div>

<style>
  .reglages {
    display: grid;
    grid-template-columns: 236px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--fond);
    color: var(--texte);
    font: 300 14px/1.5 var(--sans);
  }
  .themes {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 10px;
    border-right: 1px solid var(--bordure);
  }
  h1 {
    margin: 0 10px 4px;
    font: 500 24px/1.2 var(--serif);
  }
  .bloc {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .theme {
    position: relative;
  }
  .alerte {
    position: absolute;
    top: 50%;
    right: 12px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
    transform: translateY(-50%);
    pointer-events: none;
  }
  .resume {
    display: none;
  }

  .contenu {
    min-height: 0;
    overflow-y: auto;
    padding: 24px 32px 40px;
  }
  .colonne {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 780px;
    margin: 0 auto;
  }
  .colonne :global(.retour) {
    display: none;
  }
  .tete small {
    font: 500 10.5px var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--texte-3);
  }
  h2 {
    margin: 4px 0 6px;
    font: 500 32px/1.1 var(--serif);
  }
  .tete p {
    margin: 0;
    color: var(--texte-2);
  }
  .erreur {
    margin: 0;
    font-size: 13px;
    color: var(--danger);
  }

  @media (max-width: 767.98px) {
    .reglages {
      grid-template-columns: minmax(0, 1fr);
    }
    .themes {
      gap: 14px;
      padding: 4px 14px 24px;
      border-right: 0;
    }
    .ouvert .themes,
    .reglages:not(.ouvert) .contenu {
      display: none;
    }
    h1 {
      margin: 0 0 0 2px;
      font-size: 26px;
    }
    .themes :global(.groupe .titre) {
      min-height: 0;
      padding: 0 4px 6px;
    }
    .bloc {
      gap: 0;
      overflow: hidden;
      border: 1px solid var(--bordure);
      border-radius: var(--r-3);
      background: var(--surface-1);
    }
    .theme + .theme {
      border-top: 1px solid var(--bordure);
    }
    .themes :global(.lien) {
      gap: 12px;
      height: 50px;
      padding: 0 14px;
      border-radius: 0;
      color: var(--texte);
      font-size: 14px;
    }
    .themes :global(.lien.on) {
      background: none;
    }
    .themes :global(.lien.on::before) {
      display: none;
    }
    .themes :global(.lien .texte) {
      padding-right: 140px;
    }
    .alerte {
      display: none;
    }
    .resume {
      position: absolute;
      top: 50%;
      right: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--texte-3);
      font-size: 12.5px;
      transform: translateY(-50%);
      pointer-events: none;
    }
    .contenu {
      padding: 4px 14px 32px;
    }
    .colonne {
      gap: 14px;
    }
    .colonne :global(.retour) {
      display: inline-flex;
      align-self: flex-start;
      margin-left: -6px;
    }
    h2 {
      font-size: 28px;
    }
  }
</style>
