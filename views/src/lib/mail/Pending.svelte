<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import type { LabelView, MailSummary, TodayStats } from '../types.ts';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Field from '../ui/Field.svelte';
  import { Ban, Check, ChevronDown, Clock, Eye, ICON_STROKE, Sparkles, Trash, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import Menu from '../ui/Menu.svelte';
  import { setScreenContext, shellOf } from '../ui/shell.ts';
  import { bindShortcuts } from '../ui/shortcuts.ts';
  import Skeleton from '../ui/Skeleton.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import { toast } from '../ui/toasts.svelte.ts';
  import Avatar from './Avatar.svelte';
  import CorrectPanel from './CorrectPanel.svelte';
  import MailboxNav from './MailboxNav.svelte';
  import { boxColor, errorText, sender, shortDate, targetName } from './format.ts';

  /*
   * The queue of the AI's proposals under the threshold (plate 04), grouped by proposed box: validated
   * one by one from the keyboard (J, K, V, C, Maj+V), by group, or all above the « Tout valider »
   * threshold. Each action leaves the queue at once and offers to undo (6 s, or Z). Emptied, the
   * screen says what the sorting did today.
   */

  interface Props {
    client: AcediaClient;
    /** Something changed in the mails (an action, an undo): counters around can refresh. */
    onchange?: (() => void) | undefined;
    /** Opens a mail (the eye, Enter); the button is left out without it. */
    onopen?: ((id: string) => void) | undefined;
    /** Opens the journal, from the empty queue. */
    onjournal?: (() => void) | undefined;
    /** Shows a view of the mail screen (a box of the rail: `box:<id>`, `archive`…). */
    onview?: ((view: string) => void) | undefined;
  }
  let { client, onchange, onopen, onjournal, onview }: Props = $props();

  let items = $state<MailSummary[]>([]);
  let labels = $state<LabelView[]>([]);
  let threshold = $state<number | null>(null);
  let bulk = $state(85);
  let stats = $state<TodayStats | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let sort = $state<'confiance' | 'date'>('confiance');
  /** The card of the keyboard. */
  let current = $state<string | null>(null);
  let correcting = $state<{ open: boolean; anchor: HTMLElement | null; mails: MailSummary[] }>({
    open: false,
    anchor: null,
    mails: [],
  });

  const boxes = $derived(labels.filter((l) => l.role === 'box'));
  const tags = $derived(labels.filter((l) => l.role === 'tag'));
  const raw = (m: MailSummary) => m.proposal?.confidence ?? 0;
  // Shown rounded down: a card read « 85 % » is always taken by « Tout valider au-dessus de 85 % ».
  const confidence = (m: MailSummary) => Math.floor(raw(m));
  const key = (m: MailSummary) => (sort === 'date' ? Date.parse(m.date) : (m.proposal?.confidence ?? 0));

  const groups = $derived.by(() => {
    const by = new Map<string | null, MailSummary[]>();
    for (const m of items) {
      const boxId = m.proposal?.boxId ?? null;
      by.set(boxId, [...(by.get(boxId) ?? []), m]);
    }
    return [...by]
      .map(([boxId, mails]) => ({ boxId, mails: [...mails].sort((a, b) => key(b) - key(a)) }))
      .sort((a, b) => key(b.mails[0]!) - key(a.mails[0]!));
  });
  const ordered = $derived(groups.flatMap((g) => g.mails));
  const active = $derived(ordered.find((m) => m.id === current) ?? ordered[0]);
  const above = $derived(items.filter((m) => raw(m) >= bulk));
  const oldest = $derived(items.reduce((min, m) => (m.date < min ? m.date : min), items[0]?.date ?? ''));

  const fail = (err: unknown) => (error = errorText(err));

  /** How long the oldest proposal waits: « 2 h », « 3 j ». */
  function waited(iso: string, now = Date.now()) {
    const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
    if (minutes < 60) return `${Math.max(1, minutes)} min`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
    return `${Math.floor(minutes / (24 * 60))} j`;
  }

  const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

  /** Only the last load asked shows: an older answer arriving late is dropped. */
  let loads = 0;

  async function load() {
    const seq = ++loads;
    try {
      let page = await client.listMail('pending');
      let all = page.items;
      // The queue is short: every page, so that « Tout valider » sees all of it.
      while (page.cursor) {
        page = await client.listMail('pending', { cursor: page.cursor });
        all = [...all, ...page.items];
      }
      if (seq !== loads) return;
      items = all.filter((m) => m.proposal?.status === 'pending');
    } catch (err) {
      if (seq === loads) fail(err);
    } finally {
      if (seq === loads) loading = false;
    }
  }

  onMount(() => {
    client
      .listLabels()
      .then((l) => (labels = l))
      .catch(fail);
    client
      .getSettings()
      .then((s) => {
        threshold = s.threshold;
        bulk = Math.min(s.bulkThreshold, s.threshold);
      })
      .catch(() => {
        // Without them, the heading says nothing of the threshold and « Tout valider » keeps 85 %.
      });
    void load();
    return client.subscribe((e) => {
      if (!e.type.startsWith('mail.')) return;
      // Never reshuffle the queue under an open correction nor mid-batch: once, when it is over.
      if (correcting.open || busy) stale = true;
      else void load();
    });
  });

  /** Actions still running, and whether the server changed something meanwhile. */
  let busy = 0;
  let stale = false;
  function settle() {
    if (busy || correcting.open || !stale) return;
    stale = false;
    void load();
  }
  let wasOpen = false;
  $effect(() => {
    const open = correcting.open;
    untrack(() => {
      if (open || !wasOpen) return;
      settle();
      // The panel gives the focus back to its anchor, which may have left with its card.
      setTimeout(() => {
        if (!document.activeElement || document.activeElement === document.body) void refocus();
      });
    });
    wasOpen = open;
  });

  /** After an action, the keyboard goes on the card now current, or on the emptied queue's title. */
  async function refocus() {
    await tick();
    const card = current ? document.getElementById(`propo-${current}`) : null;
    const target = card ?? document.querySelector<HTMLElement>('.pending .vide h2');
    if (!target) return;
    if (!card) target.tabIndex = -1;
    target.focus();
  }

  // Emptied: what the sorting did today, read again each time the queue empties.
  $effect(() => {
    if (loading || items.length) return;
    untrack(() => {
      client
        .todayStats()
        .then((s) => (stats = s))
        .catch(() => (stats = null));
    });
  });

  type Journaled = { journalId?: number | undefined };

  /** What the toast says once a mail is filed. */
  function done(m: MailSummary, boxId: string | null) {
    const who = sender(m.from);
    if (boxId === 'trash') return `Mis à la corbeille : ${who}`;
    if (boxId === 'spam') return `Signalé comme spam : ${who}`;
    if (boxId === null) return `Gardé en réception : ${who}`;
    return `Rangé dans ${targetName(boxId, labels)} : ${who}`;
  }

  /**
   * Takes the mails out of the queue at once, the keyboard going to the next card, then offers to
   * undo. A refusal reloads the queue (part of a group may be done) and says so.
   */
  async function act(mails: MailSummary[], run: (m: MailSummary) => Promise<Journaled>, message: string) {
    error = null;
    const ids = mails.map((m) => m.id);
    if (active && ids.includes(active.id)) {
      const index = ordered.indexOf(active);
      const rest = ordered.filter((m) => !ids.includes(m.id));
      current = (ordered.slice(index).find((m) => !ids.includes(m.id)) ?? rest.at(-1))?.id ?? null;
    }
    items = items.filter((m) => !ids.includes(m.id));
    void refocus();
    busy++;
    const journal: number[] = [];
    try {
      // One after the other: Gmail is asked once at a time.
      for (const m of mails) {
        const r = await run(m);
        if (r.journalId !== undefined) journal.push(r.journalId);
      }
      toast(message, {
        undo: async () => {
          // One undo refused must not leave the queue showing half the batch.
          try {
            for (const id of journal.reverse()) await client.undo(id);
          } finally {
            await load();
            onchange?.();
          }
        },
      });
    } catch (err) {
      fail(err);
      stale = true;
    } finally {
      busy--;
      settle();
      onchange?.();
    }
  }

  function validate(mails: MailSummary[]) {
    if (!mails.length) return;
    const message =
      mails.length === 1
        ? done(mails[0]!, mails[0]!.proposal?.boxId ?? null)
        : `${mails.length} propositions validées`;
    return act(mails, (m) => client.validate(m.id), message);
  }

  function correct(mails: MailSummary[], boxId: string, tagIds: string[], rememberSender: boolean) {
    const message = mails.length === 1 ? done(mails[0]!, boxId) : `${mails.length} propositions corrigées`;
    return act(mails, (m) => client.correct(m.id, boxId, tagIds, { rememberSender }), message);
  }

  function openCorrect(mails: MailSummary[], anchor: HTMLElement | null) {
    correcting = { open: true, anchor, mails };
  }

  const groupOf = (m: MailSummary) => groups.find((g) => g.mails.includes(m));
  const cardOf = (m: MailSummary) => document.getElementById(`propo-${m.id}`);

  function move(step: number) {
    if (!ordered.length) return;
    const index = active ? ordered.indexOf(active) : 0;
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + step))]!;
    current = next.id;
    cardOf(next)?.focus();
  }

  /** A menu or a window has the keyboard: the screen's shortcuts wait. */
  const overlay = () => Boolean(document.activeElement?.closest('[role="menu"], [role="dialog"]'));

  $effect(() => {
    const on = (run: (m: MailSummary) => void) => () => {
      const m = active;
      if (m && !overlay() && !correcting.open) run(m);
    };
    return bindShortcuts({
      j: on(() => move(1)),
      k: on(() => move(-1)),
      v: on((m) => validate([m])),
      'Shift+v': on((m) => validate(groupOf(m)?.mails ?? [m])),
      c: on((m) => openCorrect([m], cardOf(m)?.querySelector<HTMLElement>('.corriger') ?? cardOf(m))),
    });
  });

  // ---- Touch: a card slid to the right is validated, to the left it opens the correction.
  const SWIPE = 96;
  let swipe = $state<{ id: string; x0: number; dx: number } | null>(null);

  function swipeStart(event: PointerEvent & { currentTarget: HTMLElement }, m: MailSummary) {
    if (event.pointerType === 'mouse' || (event.target as Element).closest('button')) return;
    // Captured: a finger that leaves the card still ends the slide on it.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    swipe = { id: m.id, x0: event.clientX, dx: 0 };
  }
  function swipeMove(event: PointerEvent) {
    if (swipe) swipe.dx = event.clientX - swipe.x0;
  }
  function swipeEnd(m: MailSummary, card: HTMLElement) {
    const dx = swipe?.dx ?? 0;
    swipe = null;
    if (dx > SWIPE) void validate([m]);
    else if (dx < -SWIPE) openCorrect([m], card);
  }
  const shift = (m: MailSummary) => (swipe?.id === m.id ? swipe.dx : 0);

  // ---- The shell around, if any, shows the boxes in its rail, as on the mail screen.
  const shell = shellOf();
  setScreenContext({ screen: 'pending' });
  $effect(() => {
    if (!shell) return;
    shell({ rail: nav });
    return () => shell(null);
  });

  let creating = $state<{ open: boolean; name: string; error?: string }>({ open: false, name: '' });

  async function saveBox(event: SubmitEvent) {
    event.preventDefault();
    const name = creating.name.trim();
    if (!name) return;
    try {
      const box = await client.createLabel(name, 'box');
      labels = [...labels, box];
      creating.open = false;
    } catch (err) {
      creating.error = errorText(err);
    }
  }

  const range = (mails: MailSummary[]) => {
    const values = mails.map(confidence);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return lo === hi ? `${lo} %` : `${lo} à ${hi} %`;
  };
</script>

{#snippet nav()}
  <MailboxNav
    view=""
    {boxes}
    onselect={(view) => onview?.(view)}
    oncreate={() => (creating = { open: true, name: '' })}
  />
{/snippet}

{#snippet head()}
  <header class="entete">
    <div class="titres">
      <h1>À valider</h1>
      {#if items.length}
        <p>
          <span class="large">
            {items.length}
            {plural(items.length, 'proposition', 'propositions')}{#if threshold !== null}{' '}sous le seuil de {threshold}&nbsp;%{/if}.
            La plus ancienne attend depuis {waited(oldest)}.
          </span>
          <span class="court">
            {items.length}{#if threshold !== null}{' '}sous le seuil de {threshold}&nbsp;%{/if}
          </span>
        </p>
      {/if}
    </div>
    {#if items.length}
      <div class="droite">
        <span class="trier">
          <span class="legende">Trier par</span>
          <Menu
            label="Trier par"
            sections={[
              {
                items: [
                  { id: 'confiance', label: 'Confiance' },
                  { id: 'date', label: 'Date' },
                ],
              },
            ]}
            align="end"
            onselect={(id) => (sort = id === 'date' ? 'date' : 'confiance')}
          >
            {#snippet trigger({ props })}
              <Button {...props} variant="secondaire" size="petit" aria-label="Trier par"
                >{sort === 'date' ? 'Date' : 'Confiance'}<ChevronDown
                  size={14}
                  strokeWidth={ICON_STROKE}
                  aria-hidden="true"
                /></Button
              >
            {/snippet}
          </Menu>
        </span>
        <Button
          variant="doux"
          size="petit"
          icon={Check}
          class="tout"
          disabled={above.length === 0}
          onclick={() => validate(above)}
        >
          <span class="large">Tout valider au-dessus de {bulk}&nbsp;%</span>
          <span class="court">Tout ≥&nbsp;{bulk}&nbsp;%</span>
        </Button>
      </div>
    {/if}
  </header>
{/snippet}

<div class="pending lun-acedia" data-monde="acedia">
  {#if error}
    <Banner title={error} class="erreur">
      {#snippet action()}
        <IconButton icon={X} label="Fermer le message" size="petit" onclick={() => (error = null)} />
      {/snippet}
    </Banner>
  {/if}

  {#if loading}
    <div class="file" aria-busy="true">
      {@render head()}
      <div class="lot">
        {#each [0, 1, 2] as i (i)}
          <div class="carte attente">
            <Skeleton shape="rond" />
            <div class="corps">
              <Skeleton width="30%" />
              <Skeleton width="75%" />
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else if items.length === 0}
    <div class="vide">
      <EmptyState
        title="Rien à valider"
        message="Toutes les propositions sont traitées. Les prochains mails incertains arriveront ici."
        size="grand"
      >
        {#if stats}
          <div class="stats">
            <div class="stat">
              <b>{stats.autoFiled}</b>{plural(stats.autoFiled, 'rangé seul', 'rangés seuls')} aujourd’hui
            </div>
            <div class="stat"><b>{stats.validated}</b>{plural(stats.validated, 'validé', 'validés')}</div>
            <div class="stat"><b>{stats.corrected}</b>{plural(stats.corrected, 'corrigé', 'corrigés')}</div>
          </div>
        {/if}
        {#if onjournal}
          <Button variant="fantome" size="petit" icon={Clock} onclick={onjournal}>Voir le journal</Button>
        {/if}
      </EmptyState>
    </div>
  {:else}
    <div class="file">
      {@render head()}
      {#each groups as group (group.boxId)}
        {@const name = targetName(group.boxId, labels)}
        {@const n = group.mails.length}
        <section class="lot" aria-label={name}>
          <header class="lot-tete">
            {#if group.boxId === 'spam'}
              <Ban size={16} strokeWidth={ICON_STROKE} class="danger" aria-hidden="true" />
            {:else if group.boxId === 'trash'}
              <Trash size={16} strokeWidth={ICON_STROKE} class="danger" aria-hidden="true" />
            {:else if group.boxId === null}
              <Sparkles size={16} strokeWidth={ICON_STROKE} class="ia" aria-hidden="true" />
            {:else}
              <span class="pastille" style:background={boxColor(group.boxId)} aria-hidden="true"></span>
            {/if}
            <h2>{name}</h2>
            <small>{n} {plural(n, 'proposition', 'propositions')} · confiance {range(group.mails)}</small>
            <div class="droite">
              {#if n > 1}
                <Button
                  variant="fantome"
                  size="petit"
                  onclick={(event) => openCorrect(group.mails, event.currentTarget)}>Tout corriger…</Button
                >
              {/if}
              <Button
                variant="doux"
                size="petit"
                icon={Check}
                aria-keyshortcuts="Shift+V"
                onclick={() => validate(group.mails)}>{n > 1 ? `Valider les ${n}` : 'Valider'}</Button
              >
            </div>
          </header>
          {#each group.mails as m (m.id)}
            {@const c = confidence(m)}
            {@const dx = shift(m)}
            <div class="pile">
              {#if dx}
                <div class={['fond', dx > 0 ? 'valider' : 'corriger-fond']} aria-hidden="true">
                  {#if dx > 0}
                    <Check size={16} strokeWidth={ICON_STROKE} />Valider
                  {:else}
                    Corriger<ChevronDown size={16} strokeWidth={ICON_STROKE} />
                  {/if}
                </div>
              {/if}
              <!-- One Tab stop for the queue (roving tabindex); J, K, V, C come from the window. -->
              <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
              <article
                id="propo-{m.id}"
                class={['carte', { actif: m === active, glisse: dx !== 0 }]}
                aria-current={m === active}
                aria-label="{sender(m.from)} : {m.subject}"
                tabindex={m === active ? 0 : -1}
                style:transform={dx ? `translateX(${dx}px)` : undefined}
                onfocus={() => (current = m.id)}
                onclick={() => (current = m.id)}
                onkeydown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter') onopen?.(m.id);
                  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    move(event.key === 'ArrowDown' ? 1 : -1);
                  }
                }}
                onpointerdown={(event) => swipeStart(event, m)}
                onpointermove={swipeMove}
                onpointerup={(event) => swipeEnd(m, event.currentTarget)}
                onpointercancel={() => (swipe = null)}
                onlostpointercapture={() => (swipe = null)}
              >
                <Avatar name={sender(m.from)} />
                <div class="corps">
                  <div class="l1">
                    <span class="de">{sender(m.from)}</span>
                    <span class="heure">{shortDate(m.date)}</span>
                  </div>
                  <p class="l2">
                    <b class="objet">{m.subject}</b>{#if m.snippet}<span class="apercu"
                        >{' · '}{m.snippet}</span
                      >{/if}
                  </p>
                  {#if m.proposal?.reason}
                    <p class="pourquoi">
                      <Sparkles size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                      <span>{m.proposal.reason}</span>
                    </p>
                  {/if}
                </div>
                <div class="actions">
                  <span class="propo-m">
                    <Sparkles size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />{name} · {c}&nbsp;%
                  </span>
                  <span class="jauge">
                    <span class="barre" aria-hidden="true"><span style:width="{c}%"></span></span>
                    <span class="valeur"><span class="sr">confiance </span>{c}&nbsp;%</span>
                  </span>
                  <Button
                    variant="doux"
                    size="petit"
                    icon={Check}
                    class="valider"
                    aria-keyshortcuts="V"
                    onclick={() => validate([m])}>Valider</Button
                  >
                  <Button
                    variant="secondaire"
                    size="petit"
                    class="corriger"
                    aria-haspopup="dialog"
                    aria-keyshortcuts="C"
                    onclick={(event) => openCorrect([m], event.currentTarget)}
                    >Corriger<ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" /></Button
                  >
                  {#if onopen}
                    <IconButton
                      icon={Eye}
                      label="Ouvrir le mail"
                      shortcut="↵"
                      size="petit"
                      class="ouvrir"
                      onclick={() => onopen(m.id)}
                    />
                  {/if}
                </div>
              </article>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {/if}
</div>

<CorrectPanel
  bind:open={correcting.open}
  anchor={correcting.anchor}
  {boxes}
  {tags}
  proposed={correcting.mails[0]?.proposal?.boxId ?? null}
  initialTags={correcting.mails[0]?.proposal?.tagIds ?? []}
  single={correcting.mails.length === 1}
  onapply={(boxId, tagIds, remember) => correct(correcting.mails, boxId, tagIds, remember)}
/>

<Dialog
  title="Nouvelle boîte"
  description="Elle devient un libellé Gmail."
  bind:open={creating.open}
  width={400}
>
  <form id="nouvelle-boite-attente" onsubmit={saveBox}>
    <Field label="Nom de la boîte" error={creating.error}>
      <TextInput bind:value={creating.name} placeholder="Factures" required />
    </Field>
  </form>
  {#snippet footer({ close: cancel })}
    <Button variant="fantome" onclick={cancel}>Annuler</Button>
    <Button type="submit" variant="principal" form="nouvelle-boite-attente" disabled={!creating.name.trim()}
      >Créer</Button
    >
  {/snippet}
</Dialog>

<style>
  .pending {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .pending > :global(.erreur) {
    margin: 14px 24px 0;
  }
  .file {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 18px;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 24px 24px;
  }

  /* ---- Heading */
  .entete {
    display: flex;
    align-items: flex-end;
    gap: 16px;
  }
  h1 {
    margin: 0;
    font: 500 30px/1.1 var(--serif);
  }
  .titres p {
    margin: 4px 0 0;
    font-size: 13.5px;
    color: var(--texte-2);
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
  .trier {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .legende {
    font-size: 12.5px;
    color: var(--texte-3);
  }
  .entete :global(.tout) {
    height: 34px;
    padding: 0 14px;
    font-size: 13.5px;
    border-radius: var(--r-2);
  }

  /* ---- A group: one proposed box */
  .lot {
    flex: none;
    background: var(--surface-1);
    border: 1px solid var(--bordure);
    border-radius: var(--r-3);
  }
  .lot-tete {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--bordure);
  }
  .lot-tete h2 {
    margin: 0;
    font: 500 14px var(--sans);
  }
  .lot-tete small {
    font-size: 12.5px;
    color: var(--texte-3);
  }
  .lot-tete :global(.danger) {
    flex: none;
    color: var(--danger);
  }
  .lot-tete :global(.ia) {
    flex: none;
    color: var(--ia);
  }
  .lot-tete .droite {
    gap: 6px;
  }
  .pastille {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  /* ---- A card */
  .pile {
    position: relative;
    border-bottom: 1px solid var(--bordure);
  }
  .pile:last-child {
    border-bottom: 0;
  }
  .pile:last-child .carte {
    border-radius: 0 0 var(--r-3) var(--r-3);
  }
  .carte {
    position: relative;
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) auto;
    align-items: start;
    gap: 12px;
    padding: 12px 14px;
    outline: none;
  }
  .carte.actif {
    background: var(--accent-doux);
    box-shadow: inset 3px 0 0 var(--accent-texte);
  }
  .carte:focus-visible {
    box-shadow:
      inset 3px 0 0 var(--accent-texte),
      inset 0 0 0 1px var(--accent-bord);
  }
  .carte.attente {
    grid-template-columns: 30px 1fr;
    border-bottom: 1px solid var(--bordure);
  }
  .carte.attente .corps {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 2px;
  }
  .corps {
    min-width: 0;
  }
  .l1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .de {
    overflow: hidden;
    font-size: 13.5px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .heure {
    font-size: 12px;
    color: var(--texte-3);
    white-space: nowrap;
  }
  .l2 {
    margin: 1px 0 0;
    overflow: hidden;
    font-size: 13px;
    color: var(--texte-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .objet {
    font-weight: 400;
    color: var(--texte);
  }
  .pourquoi {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--ia);
  }
  .pourquoi :global(svg) {
    flex: none;
  }
  .pourquoi span {
    color: var(--texte-2);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
  }
  .jauge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: 4px;
    font-size: 12px;
    color: var(--texte-3);
  }
  .barre {
    width: 52px;
    height: 4px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--surface-3);
  }
  .barre span {
    display: block;
    height: 100%;
    background: var(--ia);
  }
  .valeur {
    min-width: 34px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .propo-m {
    display: none;
  }
  .fond {
    display: none;
  }

  /* ---- Emptied */
  .vide {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    overflow-y: auto;
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
  }
  .stat {
    padding: 10px 16px;
    background: var(--surface-1);
    border: 1px solid var(--bordure);
    border-radius: var(--r-2);
    font-size: 12.5px;
    color: var(--texte-3);
    text-align: left;
  }
  .stat b {
    display: block;
    font: 500 20px var(--sans);
    color: var(--texte);
  }

  /* ---- Phone: one card per mail, in a pile; slide right to validate, left to correct. */
  @media (max-width: 767.98px) {
    .pending > :global(.erreur) {
      margin: 10px 14px 0;
    }
    .file {
      gap: 0;
      padding: 6px 0 calc(68px + 16px);
    }
    .entete {
      align-items: center;
      justify-content: space-between;
      padding: 0 14px 10px;
    }
    h1 {
      font-size: 24px;
    }
    .titres p {
      margin-top: 0;
      font-size: 12px;
      color: var(--texte-3);
    }
    .large,
    .trier {
      display: none;
    }
    .court {
      display: inline;
    }
    .entete :global(.tout) {
      height: 28px;
      padding: 0 10px;
      font-size: 12.5px;
      border-radius: var(--r-1);
    }
    .lot {
      background: none;
      border: 0;
    }
    .lot-tete {
      display: none;
    }
    .pile,
    .pile:last-child {
      margin: 0 14px 10px;
      overflow: hidden;
      border: 1px solid var(--bordure);
      border-radius: var(--r-3);
    }
    .carte,
    .pile:last-child .carte {
      display: block;
      padding: 12px;
      background: var(--surface-1);
      border-radius: var(--r-3);
      touch-action: pan-y;
    }
    .carte.actif {
      background: var(--surface-1);
      box-shadow: none;
    }
    .carte.glisse {
      transition: none;
    }
    .carte:not(.glisse) {
      transition: transform 160ms ease;
    }
    .carte > :global(.avatar),
    .apercu,
    .pourquoi :global(svg),
    .jauge,
    .actions :global(.ouvrir) {
      display: none;
    }
    .l1 .heure {
      margin-left: auto;
    }
    .l2 {
      white-space: normal;
    }
    .pourquoi {
      margin-top: 4px;
    }
    .pourquoi span {
      color: var(--texte-3);
    }
    .actions {
      margin-top: 8px;
      padding: 0;
    }
    .propo-m {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 22px;
      margin-right: auto;
      padding: 0 8px;
      background: var(--ia-doux);
      border: 1px solid var(--ia-bord);
      border-radius: 11px;
      color: var(--ia);
      font-size: 11.5px;
      white-space: nowrap;
    }
    .actions :global(.valider) {
      order: 2;
    }
    .actions :global(.corriger svg) {
      display: none;
    }
    .fond {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 18px;
      font-size: 13px;
    }
    .fond.valider {
      background: var(--ok-doux);
      color: var(--ok);
    }
    .fond.corriger-fond {
      justify-content: flex-end;
      background: var(--ia-doux);
      color: var(--ia);
    }
    .vide {
      padding-bottom: 68px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .carte:not(.glisse) {
      transition: none;
    }
  }
</style>
