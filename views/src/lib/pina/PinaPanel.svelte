<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import type { ScreenContext } from '../types.ts';
  import IconButton from '../ui/IconButton.svelte';
  import {
    Calendar,
    Clock,
    ICON_STROKE,
    Inbox,
    List,
    Mail,
    Maximize,
    Minimize,
    Minus,
    Pencil,
    Send,
    Settings,
    Shield,
    Sparkles,
    X,
  } from '../ui/Icon.ts';
  import type { ShownContext } from '../ui/shell.ts';
  import { bindShortcuts } from '../ui/shortcuts.ts';
  import { dayLabel, targetsOf, type Names } from './cards.ts';
  import History from './History.svelte';
  import Launcher from './Launcher.svelte';
  import { PinaState, type Size } from './pina.svelte.ts';
  import Thread from './Thread.svelte';

  /*
   * Pina's window (plate 01): a launcher in the bottom-right corner, and a floating window that
   * overlays the screen without ever resizing it. Resized by its left edge, its top edge or its
   * top-left corner, or enlarged to the full height on the right; the size is kept. Ctrl J opens and
   * closes it from anywhere, a field included. Under 768 px: a sheet rising from the bottom, opened
   * by the violet button of the top bar.
   */

  interface Props {
    client: AcediaClient;
    open?: boolean | undefined;
    /** Out: the pending cards of the day, for the badges around. */
    pending?: number | undefined;
    /** What the screen shows (`setScreenContext`); `screen` alone when the screen says nothing. */
    context?: ShownContext | null | undefined;
    screen?: ScreenContext['screen'] | undefined;
    /** « Ouvrir le brouillon »: the composer, on that Gmail draft. */
    onopendraft?: ((id: string) => void) | undefined;
    onsettings?: (() => void) | undefined;
  }

  let {
    client,
    open = $bindable(false),
    pending = $bindable(0),
    context = null,
    screen = 'mail',
    onopendraft = () => {},
    onsettings = () => {},
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  const pina = new PinaState(client);
  let text = $state('');
  let field = $state<HTMLTextAreaElement | null>(null);
  let fil = $state<HTMLElement | null>(null);
  let launcher = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLElement | null>(null);
  let labels = $state.raw(new Map<string, string>());

  const ctx = $derived(context ?? { screen });
  const shown = $derived(pina.past ?? pina.thread);
  const names = $derived.by((): Names => {
    const targets = targetsOf(shown);
    if (ctx.mailId && ctx.label) targets.set(ctx.mailId, { name: ctx.label });
    return { labels, targets };
  });

  $effect(() => {
    pending = pina.pending;
  });

  let loaded = false;
  $effect(() => {
    if (!open && loaded) return;
    loaded = true;
    untrack(() => {
      void pina.load();
      if (!open) return;
      void pina.loadAround();
      if (!labels.size)
        client
          .listLabels()
          .then((l) => (labels = new Map(l.map((x) => [x.id, x.name]))))
          .catch(() => {});
    });
  });

  const isPhone = () => window.matchMedia?.('(max-width: 767.98px)').matches ?? false;
  /** On a phone the sheet is modal: the focus stays inside until it closes. */
  const modal = $derived(open && isPhone());
  /** Another window has the keyboard (a Bits dialog, the palette): Ctrl J leaves it alone. */
  const otherDialog = () =>
    [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
      (d) => d !== panel && d.getAttribute('aria-modal') === 'true',
    );

  // Ctrl J from anywhere, a field included.
  $effect(() =>
    bindShortcuts({ 'Ctrl+j': () => !otherDialog() && void toggle() }, window, { fromFields: ['Ctrl+j'] }),
  );

  // The latest message in view.
  $effect(() => {
    void [shown, pina.asking];
    if (fil) fil.scrollTop = fil.scrollHeight;
  });

  /** Where the focus was when the window opened (the phone's top-bar button). */
  let opener: HTMLElement | null = null;

  /** Opens or closes the window: the launcher, Ctrl J, the phone's button and « Ouvrir le brouillon » all come here. */
  export async function toggle() {
    if (!open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      open = true;
      return;
    }
    const active = document.activeElement;
    const inside = !active || active === document.body || panel?.contains(active);
    open = false;
    pina.past = null;
    await tick();
    if (inside) (isPhone() ? opener : launcher)?.focus();
  }

  // On a desktop the window stays over the screen reached (it never resizes it); the phone's sheet would hide it.
  function leaveFor(go: () => void) {
    if (open && isPhone()) void toggle();
    go();
  }
  const openDraft = (id: string) => leaveFor(() => onopendraft(id));
  const openSettings = () => leaveFor(onsettings);

  /** After a decision: the next pending card, else Pina's field (unless the focus went elsewhere). */
  async function settled() {
    await tick();
    const active = document.activeElement;
    if (!panel || (active && active !== document.body && !panel.contains(active))) return;
    (panel.querySelector<HTMLElement>('[data-attente]') ?? field)?.focus();
  }

  /** Tab and Shift Tab go round inside the sheet while it is modal. */
  function trap(event: KeyboardEvent) {
    if (!modal || event.key !== 'Tab' || !panel) return;
    const stops = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea, input, a[href], [tabindex="0"]',
      ),
    ].filter((e) => e.getClientRects().length > 0);
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** The context as the server takes it: without the pill's label nor empty fields. */
  function sent(): ScreenContext {
    const { screen: s, mailId, day, listId, draftId } = ctx;
    return Object.fromEntries(
      Object.entries({ screen: s, mailId, day, listId, draftId }).filter(([, v]) => v !== undefined),
    ) as unknown as ScreenContext;
  }

  async function ask() {
    const request = text.trim();
    if (!request || pina.asking) return;
    text = '';
    await pina.ask(request, sent());
  }

  function onfieldkey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void ask();
    } else if (event.key === 'ArrowUp' && !text && pina.lastRequest) {
      event.preventDefault();
      text = pina.lastRequest;
    }
  }

  function fill(request: string) {
    text = request;
    field?.focus();
  }

  const SCREENS: Record<ScreenContext['screen'], { name: string; icon: typeof Mail }> = {
    mail: { name: 'Réception', icon: Inbox },
    pending: { name: 'À valider', icon: Sparkles },
    agenda: { name: 'Agenda', icon: Calendar },
    tasks: { name: 'Tâches', icon: List },
    journal: { name: 'Journal', icon: Clock },
    settings: { name: 'Réglages', icon: Settings },
    compose: { name: 'Rédaction', icon: Pencil },
  };
  const pill = $derived.by(() => {
    const { icon, name } = SCREENS[ctx.screen];
    if (ctx.screen === 'mail' && ctx.mailId) return { icon: Mail, text: `« ${ctx.label ?? 'Mail ouvert'} »` };
    return { icon, text: ctx.label ?? name };
  });

  const suggestions = $derived.by((): string[] => {
    switch (ctx.screen) {
      case 'mail':
        return ctx.mailId
          ? ['Résumer ce mail', 'Ajouter à l’agenda', 'Préparer une réponse']
          : ['Ce qui est important aujourd’hui', 'Les mails qui attendent une réponse'];
      case 'pending':
        return ['Expliquer ces propositions'];
      case 'agenda':
        return ['Ce qui est prévu aujourd’hui', 'Ajouter un événement'];
      case 'tasks':
        return ['Ajouter une tâche', 'Les tâches en retard'];
      case 'journal':
        return ['Résumer la journée'];
      default:
        return [];
    }
  });

  // ---- Size: the left edge, the top edge and the corner pull the window; it stays anchored bottom right.
  type Edge = 'gauche' | 'haut' | 'coin';
  let drag: { edge: Edge; x: number; y: number; start: Size; id: number } | null = null;

  function grab(edge: Edge) {
    return (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      drag = { edge, x: event.clientX, y: event.clientY, start: { ...pina.size }, id: event.pointerId };
    };
  }
  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    const { edge, x, y, start } = drag;
    pina.setSize({
      width: edge === 'haut' ? start.width : start.width + x - event.clientX,
      height: edge === 'gauche' ? start.height : start.height + y - event.clientY,
    });
    if (edge !== 'gauche') pina.maximized = false;
  }
  function release(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    pina.setSize(pina.size, true);
  }
  /** Arrows on a focused edge: 16 px a press. */
  function nudge(edge: 'gauche' | 'haut') {
    return (event: KeyboardEvent) => {
      const step = { ArrowLeft: 16, ArrowRight: -16, ArrowUp: 16, ArrowDown: -16 }[event.key];
      const along = edge === 'gauche' ? /Left|Right/.test(event.key) : /Up|Down/.test(event.key);
      if (!step || !along) return;
      event.preventDefault();
      const { width, height } = pina.size;
      pina.setSize(
        edge === 'gauche' ? { width: width + step, height } : { width, height: height + step },
        true,
      );
      if (edge === 'haut') pina.maximized = false;
    };
  }

  // ---- Phone: the sheet goes down when its handle is pulled.
  let pull: { y: number; id: number } | null = null;
</script>

<svelte:window onresize={() => pina.fit()} />

{#if open}
  <button type="button" class="voile" tabindex="-1" aria-label="Fermer Pina" onclick={toggle}></button>
  <div
    bind:this={panel}
    class={['panneau', { grande: pina.maximized }]}
    role="dialog"
    aria-modal={modal}
    tabindex="-1"
    aria-label="Pina"
    onkeydown={trap}
    {@attach (node) => {
      // The sheet takes the focus on a phone; on a wider screen the field does.
      if (isPhone()) node.focus();
    }}
    style:--largeur={`${pina.size.width}px`}
    style:--hauteur={`${pina.size.height}px`}
    onpointermove={move}
    onpointerup={release}
    onpointercancel={release}
  >
    <!-- A focusable separator is a resize control (WAI-ARIA window splitter): arrows change the size. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="bord gauche"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      aria-label="Largeur de Pina"
      aria-valuenow={pina.size.width}
      aria-valuemin={340}
      onpointerdown={grab('gauche')}
      onkeydown={nudge('gauche')}
    ></div>
    {#if !pina.maximized}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="bord haut"
        role="separator"
        tabindex="0"
        aria-orientation="horizontal"
        aria-label="Hauteur de Pina"
        aria-valuenow={pina.size.height}
        aria-valuemin={420}
        onpointerdown={grab('haut')}
        onkeydown={nudge('haut')}
      ></div>
    {/if}
    <div class="bord coin" aria-hidden="true" onpointerdown={grab('coin')}></div>
    <div
      class="poignee"
      aria-hidden="true"
      onpointerdown={(e) => (pull = { y: e.clientY, id: e.pointerId })}
      onpointerup={(e) => {
        if (pull && e.pointerId === pull.id && e.clientY - pull.y > 60) void toggle();
        pull = null;
      }}
    ></div>

    <header class="p-tete">
      <span class="nom"><Sparkles size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />Pina</span>
      <div class="fin">
        <History
          days={pina.days}
          today={pina.thread?.day}
          onopen={() => void pina.loadAround()}
          onpick={(day) => void pina.openDay(day)}
        />
        <span class="large">
          <IconButton
            icon={pina.maximized ? Minimize : Maximize}
            size="petit"
            label={pina.maximized ? 'Rétablir la taille' : 'Agrandir'}
            onclick={() => (pina.maximized = !pina.maximized)}
          />
          <IconButton icon={Minus} size="petit" label="Réduire" shortcut="Ctrl J" onclick={toggle} />
        </span>
        <span class="court"><IconButton icon={X} size="petit" label="Fermer" onclick={toggle} /></span>
      </div>
    </header>
    <div class="mode">
      <Shield size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <b
        >{pina.mode === 'immediate'
          ? 'Actions faites tout de suite, avec Annuler'
          : 'Validation avant chaque action'}</b
      >
      <button type="button" class="lien" onclick={openSettings}>Réglages</button>
    </div>

    {#if pina.past}
      <div class="passe">
        <span>Fil du {dayLabel(pina.past.day)}, en lecture seule</span>
        <button type="button" class="lien" onclick={() => (pina.past = null)}>Revenir à aujourd’hui</button>
      </div>
    {/if}

    <div class="fil" bind:this={fil} role="log" aria-label="Échanges avec Pina">
      {#if !pina.past}
        <span class="contexte">
          <pill.icon size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>Contexte : {pill.text}</span>
        </span>
      {/if}
      {#if shown}
        {#if !shown.messages.length && !pina.asking}
          <p class="vide">
            Aucun échange aujourd’hui. Pina lit les mails, l’agenda et les tâches, et propose chaque action en
            carte avant de la faire.
          </p>
        {/if}
        <Thread
          thread={shown}
          {pina}
          {names}
          readonly={!!pina.past}
          onopendraft={openDraft}
          onsettled={settled}
          onrephrase={() => fill('Reformuler le brouillon : ')}
          onsettings={openSettings}
        />
      {/if}
      {#if pina.asking && !pina.past}
        <div class="bulle moi">{pina.asking}</div>
        <div class="bulle ia attente" aria-live="polite">
          <span class="sr">Pina réfléchit</span><i></i><i></i><i></i>
        </div>
      {/if}
    </div>

    {#if !pina.past}
      <div class="saisie">
        <div class="boite">
          <textarea
            bind:this={field}
            bind:value={text}
            rows="1"
            aria-label="Demande à Pina"
            placeholder="Demander à Pina…"
            maxlength={4000}
            onkeydown={onfieldkey}
            {@attach (node) => {
              // Not on a phone: the keyboard would cover the sheet as it rises.
              if (window.matchMedia?.('(min-width: 768px)').matches ?? true) node.focus();
            }}></textarea>
          <IconButton
            icon={Send}
            size="petit"
            variant="principal"
            label="Demander"
            disabled={!text.trim() || !!pina.asking}
            onclick={ask}
          />
        </div>
        {#if suggestions.length}
          <div class="aide">
            {#each suggestions as s (s)}
              <button type="button" class="sugg" onclick={() => fill(s)}>{s}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <Launcher bind:element={launcher} pending={pina.pending} onclick={toggle} />
{/if}

<style>
  .panneau {
    position: fixed;
    /* 22 px from the edges, down to 12 when the window takes the whole viewport minus 24. */
    right: min(22px, calc(100vw - 12px - var(--largeur)));
    bottom: min(22px, calc(100dvh - 12px - var(--hauteur)));
    z-index: 45;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: var(--largeur);
    height: var(--hauteur);
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-3);
    background: var(--surface-1);
    box-shadow: var(--ombre-2);
    color: var(--texte);
    font: 300 14px/1.5 var(--sans);
  }
  .panneau.grande {
    top: 22px;
    bottom: 22px;
    height: auto;
  }
  .bord {
    position: absolute;
    z-index: 2;
  }
  .bord:focus-visible {
    outline: 2px solid var(--ia);
    outline-offset: -2px;
  }
  .gauche {
    top: 14px;
    bottom: 14px;
    left: -4px;
    width: 8px;
    cursor: ew-resize;
  }
  .haut {
    top: -4px;
    right: 14px;
    left: 14px;
    height: 8px;
    cursor: ns-resize;
  }
  .coin {
    top: -4px;
    left: -4px;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
  }
  .grande .coin {
    cursor: ew-resize;
  }
  .voile,
  .poignee,
  .court {
    display: none;
  }
  .p-tete {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 50px;
    padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--bordure);
  }
  .nom {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 500 18px var(--serif);
  }
  .nom :global(svg) {
    color: var(--ia);
  }
  .fin,
  .large {
    display: flex;
    gap: 2px;
  }
  .fin {
    margin-left: auto;
  }
  .mode,
  .passe {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-bottom: 1px solid var(--bordure);
    background: var(--fond);
    font-size: 12px;
    color: var(--texte-3);
  }
  .mode b {
    font-weight: 400;
    color: var(--texte-2);
  }
  .passe {
    background: var(--ia-doux);
    color: var(--texte-2);
  }
  .lien {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-texte);
    font: inherit;
    cursor: pointer;
  }
  .lien:hover {
    text-decoration: underline;
  }
  .lien:focus-visible,
  .sugg:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }
  .fil {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    padding: 14px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .contexte {
    display: inline-flex;
    flex: none;
    align-self: flex-start;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    height: 24px;
    padding: 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--bordure);
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 11.5px;
    color: var(--texte-2);
  }
  .contexte span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .vide {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--texte-3);
  }
  .bulle {
    max-width: 86%;
    padding: 9px 12px;
    border-radius: 12px;
    font-size: 13.5px;
    line-height: 1.5;
    white-space: pre-line;
  }
  .moi {
    align-self: flex-end;
    border: 1px solid var(--accent-bord);
    border-bottom-right-radius: 4px;
    background: var(--accent-doux);
  }
  .ia {
    align-self: flex-start;
    border: 1px solid var(--bordure);
    border-bottom-left-radius: 4px;
    background: var(--surface-2);
  }
  .attente {
    display: flex;
    gap: 4px;
    padding: 13px 14px;
  }
  .attente i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ia);
    animation: pouls 1.2s ease-in-out infinite;
  }
  .attente i:nth-of-type(2) {
    animation-delay: 0.15s;
  }
  .attente i:nth-of-type(3) {
    animation-delay: 0.3s;
  }
  @keyframes pouls {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .attente i {
      animation: none;
      opacity: 0.7;
    }
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .saisie {
    flex: none;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--bordure);
  }
  .boite {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    min-height: 42px;
    padding: 6px 6px 6px 12px;
    box-sizing: border-box;
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
    background: var(--fond);
  }
  .boite:focus-within {
    border-color: var(--accent-bord);
  }
  textarea {
    flex: 1;
    min-height: 28px;
    max-height: 140px;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--texte);
    font: 300 13.5px/1.45 var(--sans);
    resize: none;
    field-sizing: content;
  }
  textarea:focus-visible {
    outline: none;
  }
  textarea::placeholder {
    color: var(--texte-3);
  }
  .aide {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .sugg {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--bordure-forte);
    border-radius: 13px;
    background: none;
    color: var(--texte-2);
    font: 400 12px var(--sans);
    cursor: pointer;
  }
  .sugg:hover {
    background: var(--survol);
    color: var(--texte);
  }

  @media (max-width: 767.98px) {
    .voile {
      position: fixed;
      inset: 0;
      z-index: 44;
      display: block;
      border: 0;
      background: color-mix(in srgb, var(--fond) 70%, transparent);
    }
    .panneau,
    .panneau.grande {
      top: 64px;
      right: 0;
      bottom: 0;
      left: 0;
      width: auto;
      height: auto;
      max-width: none;
      max-height: none;
      border-width: 1px 0 0;
      border-radius: 20px 20px 0 0;
      box-shadow: var(--ombre-2);
    }
    .bord,
    .large {
      display: none;
    }
    .poignee {
      display: block;
      flex: none;
      width: 40px;
      height: 4px;
      margin: 8px auto 2px;
      border-radius: 2px;
      background: var(--bordure-forte);
      touch-action: none;
    }
    .court {
      display: flex;
    }
    .p-tete {
      border-bottom: 0;
    }
  }
</style>
