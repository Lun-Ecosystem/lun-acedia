<script lang="ts" module>
  export type Screen = 'mail' | 'a-valider' | 'agenda' | 'taches' | 'journal' | 'reglages';

  /** Address of each screen, in the hash of the page. */
  export const HREF: Record<Screen, string> = {
    mail: '#/mail',
    'a-valider': '#/a-valider',
    agenda: '#/agenda',
    taches: '#/taches',
    journal: '#/journal',
    reglages: '#/reglages',
  };
</script>

<script lang="ts">
  import {
    BottomNav,
    CommandPalette,
    Fab,
    IconButton,
    Kbd,
    NavLink,
    Rail,
    ServiceCard,
    Toaster,
    icons,
    provideShell,
    type PaletteCommand,
    type ScreenParts,
    type ServiceState,
  } from '@lun-ecosystem/lunacedia-views';
  import type { Snippet } from 'svelte';

  /*
   * Shell of the standalone app (plate 03): the rail with its counters and the service card, the top
   * bar with the search (which opens the palette, Ctrl K), the toasts. Under 768 px: a top bar, the
   * bottom navigation and the floating button of the screen.
   */

  type Props = {
    current: Screen;
    service: ServiceState;
    /** Second line of the service card. */
    serviceDetail?: string | undefined;
    /** Sorting paused by hand (apart from the card: a refused key may show there instead). */
    paused: boolean;
    counts: { inbox: number; pending: number; tasks: number };
    /** Google account, for the avatar. */
    account?: string | undefined;
    /** Pauses or resumes the sorting. */
    ontogglepause: () => void;
    children: Snippet;
  };

  let {
    current,
    service,
    serviceDetail = '',
    paused,
    counts,
    account,
    ontogglepause,
    children,
  }: Props = $props();

  let parts = $state<ScreenParts | null>(null);
  let palette = $state(false);
  let search = $state('');
  /** Asked from another screen: runs once the mail screen is there. */
  let waiting: ((p: ScreenParts) => void) | null = null;

  provideShell((next) => {
    parts = next;
    if (next && waiting) {
      const run = waiting;
      waiting = null;
      run(next);
    }
  });

  /** Runs a gesture of the mail screen, going there first if needed. */
  function onMail(run: (p: ScreenParts) => void) {
    if (parts?.compose) return run(parts);
    waiting = run;
    location.hash = HREF.mail;
  }

  const go = (screen: Screen) => () => (location.hash = HREF[screen]);
  const initial = $derived((account ?? '').slice(0, 1).toUpperCase());

  const commands = $derived.by((): PaletteCommand[] => {
    const q = search.trim();
    return [
      ...(q
        ? [
            {
              id: 'rechercher',
              label: `Rechercher « ${q} » dans les mails`,
              group: 'Recherche',
              icon: icons.Search,
              run: () => onMail((p) => p.search?.(q)),
            },
          ]
        : []),
      {
        id: 'nouveau',
        label: 'Nouveau message',
        group: 'Action',
        icon: icons.Plus,
        run: () => onMail((p) => p.compose?.()),
      },
      {
        id: 'pause',
        label: paused ? 'Reprendre le tri' : 'Mettre le tri en pause',
        group: 'Action',
        icon: paused ? icons.Play : icons.Pause,
        run: ontogglepause,
      },
      { id: 'mail', label: 'Réception', group: 'Aller à', icon: icons.Inbox, run: go('mail') },
      { id: 'a-valider', label: 'À valider', group: 'Aller à', icon: icons.Sparkles, run: go('a-valider') },
      { id: 'agenda', label: 'Agenda', group: 'Aller à', icon: icons.Calendar, run: go('agenda') },
      { id: 'taches', label: 'Tâches', group: 'Aller à', icon: icons.List, run: go('taches') },
      { id: 'journal', label: 'Journal', group: 'Aller à', icon: icons.Clock, run: go('journal') },
      { id: 'reglages', label: 'Réglages', group: 'Aller à', icon: icons.Settings, run: go('reglages') },
    ];
  });

  const mobileNav = $derived([
    { href: HREF.mail, label: 'Mail', icon: icons.Mail },
    {
      href: HREF['a-valider'],
      label: 'À valider',
      icon: icons.Sparkles,
      count: counts.pending,
      countTone: 'ia' as const,
    },
    { href: HREF.agenda, label: 'Agenda', icon: icons.Calendar },
    { href: HREF.reglages, label: 'Réglages', icon: icons.Settings },
  ]);
</script>

<div class="coque lun-acedia" data-monde="acedia">
  <Rail label="Sections" class="rail">
    {#snippet header()}
      <span class="marque"><i aria-hidden="true"></i>Lun'Acedia</span>
      {@render parts?.action?.()}
    {/snippet}
    <NavLink
      href={HREF.mail}
      label="Réception"
      icon={icons.Inbox}
      count={counts.inbox}
      current={current === 'mail' && (parts?.home ?? true)}
      onclick={(event) => {
        if (current !== 'mail' || !parts?.goHome) return;
        event.preventDefault();
        parts.goHome();
      }}
    />
    <NavLink
      href={HREF['a-valider']}
      label="À valider"
      icon={icons.Sparkles}
      count={counts.pending}
      countTone="ia"
      current={current === 'a-valider'}
    />
    <NavLink href={HREF.agenda} label="Agenda" icon={icons.Calendar} current={current === 'agenda'} />
    <NavLink
      href={HREF.taches}
      label="Tâches"
      icon={icons.List}
      count={counts.tasks}
      current={current === 'taches'}
    />
    {@render parts?.rail?.()}
    {#snippet footer()}
      <NavLink href={HREF.journal} label="Journal" icon={icons.Clock} current={current === 'journal'} />
      <NavLink href={HREF.reglages} label="Réglages" icon={icons.Settings} current={current === 'reglages'} />
      <ServiceCard state={service} detail={serviceDetail} />
    {/snippet}
  </Rail>

  <div class="zone">
    <header class="haut">
      <button type="button" class="rech" aria-haspopup="dialog" onclick={() => (palette = true)}>
        <icons.Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <span class="large">Rechercher dans les mails, ou une commande</span>
        <span class="court">Rechercher</span>
        <span class="touche"><Kbd>Ctrl K</Kbd></span>
      </button>
      <div class="droite">
        <span class="pause">
          <IconButton
            icon={paused ? icons.Play : icons.Pause}
            label={paused ? 'Reprendre le tri' : 'Mettre le tri en pause'}
            onclick={ontogglepause}
          />
        </span>
        {#if initial}<span class="avatar" title={account}>{initial}</span>{/if}
      </div>
    </header>
    <main>{@render children()}</main>
  </div>

  <BottomNav
    items={mobileNav}
    current={current === 'taches' || current === 'journal' ? undefined : HREF[current]}
    class="nav-mobile"
  />
  {#if parts?.compose}
    <Fab label="Nouveau" icon={icons.Plus} class="fab" onclick={parts.compose} />
  {/if}
  <CommandPalette
    {commands}
    bind:open={palette}
    bind:search
    placeholder="Rechercher dans les mails, ou une commande"
  />
  <Toaster />
</div>

<style>
  .coque {
    display: flex;
    height: 100dvh;
    overflow: hidden;
  }
  .coque :global(.rail) {
    flex: none;
  }
  .marque {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 2px 8px 2px;
    font: 500 21px var(--serif);
  }
  .marque i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-doux);
  }
  .zone {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .haut {
    display: flex;
    flex: none;
    align-items: center;
    gap: 12px;
    height: 58px;
    padding: 0 18px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--bordure);
  }
  .rech {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    max-width: 620px;
    height: 38px;
    padding: 0 12px;
    background: var(--surface-1);
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
    color: var(--texte-3);
    font: 300 13.5px var(--sans);
    text-align: left;
    cursor: text;
  }
  .rech:hover {
    border-color: var(--accent-bord);
  }
  .rech:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }
  .touche {
    margin-left: auto;
  }
  .court {
    display: none;
  }
  .droite {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--texte-2);
    font: 500 11.5px var(--sans);
  }
  main {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .coque :global(.nav-mobile),
  .coque :global(.fab) {
    display: none;
  }

  @media (max-width: 767.98px) {
    .coque {
      flex-direction: column;
    }
    .coque :global(.rail) {
      display: none;
    }
    .haut {
      height: auto;
      padding: max(6px, env(safe-area-inset-top)) 14px 10px;
      border-bottom: 0;
    }
    .rech {
      max-width: none;
      height: 42px;
      border-radius: 21px;
    }
    .large,
    .touche,
    .pause {
      display: none;
    }
    .court {
      display: inline;
    }
    .avatar {
      width: 36px;
      height: 36px;
    }
    .coque :global(.nav-mobile) {
      display: grid;
      flex: none;
    }
    .coque :global(.fab) {
      display: inline-flex;
    }
  }
</style>
