<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, type AcediaClient } from '../client.ts';
  import type { JournalEntry, LabelView } from '../types.ts';
  import Badge from '../ui/Badge.svelte';
  import Banner from '../ui/Banner.svelte';
  import Button from '../ui/Button.svelte';
  import Chip from '../ui/Chip.svelte';
  import DayGroup from '../ui/DayGroup.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import {
    ArrowLeft,
    Ban,
    CircleAlert,
    Clock,
    Eye,
    Funnel,
    Hand,
    ICON_STROKE,
    Reply,
    Settings,
    Sparkles,
  } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import ListRow from '../ui/ListRow.svelte';
  import { setScreenContext } from '../ui/shell.ts';
  import Skeleton from '../ui/Skeleton.svelte';
  import { boxColor, dayLabel, errorText, time } from './format.ts';

  /*
   * The journal of the sorting (plate 07): what a rule, the AI or a gesture did to the mails, grouped
   * by day, each line undoable. A refused undo says why under its own line. The filters apply to the
   * lines loaded. The journal keeps no rule number: a rule shows as « par une règle ».
   */

  interface Props {
    client: AcediaClient;
    /** Something changed in the mails (an undo): counters around can refresh. */
    onchange?: (() => void) | undefined;
    /** Opens a mail (the row, « Ouvrir »); left out without it. */
    onopen?: ((id: string) => void) | undefined;
    /** Opens the settings of the sorting (the empty journal, the back arrow on a phone). */
    onsettings?: (() => void) | undefined;
  }
  let { client, onchange, onopen, onsettings }: Props = $props();

  /** The server's answer to an undo of a line already undone (server/src/triage/journal.ts). */
  const ALREADY_UNDONE = 'Action déjà annulée';

  setScreenContext({ screen: 'journal' });

  const ORIGINS = {
    ai: { label: 'IA', by: 'par l’IA', icon: Sparkles },
    rule: { label: 'Règle', by: 'par une règle', icon: Funnel },
    pina: { label: 'Pina', by: 'par Pina', icon: Sparkles },
    user: { label: 'À la main', by: 'à la main', icon: Hand },
  } as const;

  const FILTERS = [
    { id: 'tout', label: 'Tout', icon: undefined, keep: () => true },
    { id: 'ia', label: 'IA', icon: Sparkles, keep: (e: JournalEntry) => e.origin === 'ai' },
    { id: 'regles', label: 'Règles', icon: Funnel, keep: (e: JournalEntry) => e.origin === 'rule' },
    { id: 'annules', label: 'Annulés', icon: undefined, keep: (e: JournalEntry) => e.undoneAt !== null },
  ] as const;

  let items = $state.raw<JournalEntry[]>([]);
  let cursor = $state<number | undefined>();
  let labels = $state.raw<LabelView[]>([]);
  let loading = $state(true);
  let more = $state(false);
  let error = $state<string | null>(null);
  let filter = $state<(typeof FILTERS)[number]['id']>('tout');
  /** Undos running, and the refusals, by journal line. */
  let undoing = $state<Record<number, boolean>>({});
  let refused = $state<Record<number, string>>({});

  const shown = $derived(items.filter(FILTERS.find((f) => f.id === filter)!.keep));
  const days = $derived.by(() => {
    const groups: { key: string; label: string; entries: JournalEntry[] }[] = [];
    for (const e of shown) {
      // Keyed by the calendar day: a label like « lun. 19 oct. » comes back every few years.
      const key = new Date(e.at).toDateString();
      const last = groups.at(-1);
      if (last?.key === key) last.entries.push(e);
      else groups.push({ key, label: dayLabel(e.at), entries: [e] });
    }
    return groups;
  });

  async function load(next?: number) {
    error = null;
    if (next) more = true;
    // A first load retried: the skeleton, not an empty journal, while it runs.
    else if (!items.length) loading = true;
    try {
      const page = await client.journal(next);
      items = next ? [...items, ...page.items] : page.items;
      cursor = page.cursor;
    } catch (err) {
      error = errorText(err);
    } finally {
      loading = more = false;
    }
  }

  onMount(() => {
    void load();
    client
      .listLabels()
      .then((l) => (labels = l))
      .catch(() => {
        // Without the labels, a box shows by its id.
      });
  });

  type Where = { verb: string; box?: { id: string; name: string } | undefined; spam?: boolean };

  /** Where the mail went: « Rangé dans [École] », « Envoyé en [Spam] ». */
  function where(e: JournalEntry): Where {
    if (e.action === 'trash') return { verb: 'Mis à la corbeille' };
    if (e.action === 'spam') return { verb: 'Envoyé en', spam: true };
    const box = e.after.find((l) => !e.before.includes(l) && labels.find((x) => x.id === l)?.role === 'box');
    if (box) return { verb: 'Rangé dans', box: { id: box, name: labels.find((x) => x.id === box)!.name } };
    if (e.action === 'archive' || (e.before.includes('INBOX') && !e.after.includes('INBOX')))
      return { verb: 'Archivé' };
    if (e.action === 'validate') return { verb: 'Proposition validée' };
    if (e.action === 'correct') return { verb: 'Proposition corrigée' };
    return { verb: 'Rangé' };
  }

  /** What a screen reader says of a focused row: « Sujet 1 : rangé dans École par l’IA ». */
  function rowLabel(e: JournalEntry, w: Where) {
    const target = w.box ? ` ${w.box.name}` : w.spam ? ' Spam' : '';
    const undone = e.undoneAt ? `, ${undoneText(e, e.undoneAt)}` : '';
    return `${e.subject || 'Sans objet'} : ${w.verb.toLowerCase()}${target} ${ORIGINS[e.origin].by}${undone}`;
  }

  /** « annulé à 18:41 » the same day, « annulé le 21 oct. » later. */
  function undoneText(e: JournalEntry, undoneAt: string) {
    if (new Date(undoneAt).toDateString() === new Date(e.at).toDateString())
      return `annulé à ${time(undoneAt)}`;
    return `annulé le ${new Date(undoneAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
  }

  async function undo(e: JournalEntry) {
    delete refused[e.id];
    undoing[e.id] = true;
    try {
      await client.undo(e.id);
      const undoneAt = new Date().toISOString();
      items = items.map((x) => (x.id === e.id ? { ...x, undoneAt } : x));
      onchange?.();
    } catch (err) {
      // Undone meanwhile (another device): the line is stale, the journal is read again.
      if (err instanceof ApiError && err.status === 409 && err.message === ALREADY_UNDONE) {
        await load();
        onchange?.();
      } else refused[e.id] = errorText(err);
    } finally {
      delete undoing[e.id];
    }
  }
</script>

<section class="journal lun-acedia" data-monde="acedia" aria-labelledby="journal-titre">
  <div class="colonne">
    <header class="entete">
      {#if onsettings}
        <IconButton icon={ArrowLeft} label="Retour aux réglages" class="retour" onclick={onsettings} />
      {/if}
      <div>
        <h1 id="journal-titre">Journal du tri</h1>
        <p>
          Ce que le tri et les gestes à la main ont fait aux mails. Rien n’est définitif : chaque action
          s’annule.
        </p>
      </div>
    </header>

    {#if error}
      <Banner title={error} class="erreur">
        {#snippet action()}
          <Button variant="secondaire" size="petit" onclick={() => load(items.length ? cursor : undefined)}
            >Réessayer</Button
          >
        {/snippet}
      </Banner>
    {/if}

    {#if loading}
      <div aria-busy="true" aria-label="Chargement du journal">
        {#each [0, 1, 2, 3] as i (i)}
          <div class="attente">
            <Skeleton width="40px" />
            <Skeleton shape="rond" />
            <div class="lignes"><Skeleton width="{70 - i * 8}%" /><Skeleton width="35%" /></div>
          </div>
        {/each}
      </div>
    {:else if items.length === 0 && !error}
      <EmptyState
        title="Rien pour l’instant"
        message="Quand une règle, l’IA ou un geste à la main range un mail, l’action apparaît ici et peut être annulée."
        icon={Clock}
        tone="neutre"
        size="grand"
      >
        {#if onsettings}
          <Button variant="secondaire" size="petit" icon={Settings} onclick={onsettings}
            >Régler le seuil</Button
          >
        {/if}
      </EmptyState>
    {:else if items.length}
      <div class="filtres" role="group" aria-label="Filtrer le journal">
        {#each FILTERS as f (f.id)}
          <Chip on={filter === f.id} icon={f.icon} class={f.id} onclick={() => (filter = f.id)}
            >{f.label}</Chip
          >
        {/each}
      </div>

      {#if shown.length === 0}
        <p class="aucun">Aucune action de ce type parmi celles chargées.</p>
      {/if}
      {#each days as day (day.key)}
        <DayGroup label={day.label} level={2}>
          <ul>
            {#each day.entries as e (e.id)}
              {@const origin = ORIGINS[e.origin]}
              {@const w = where(e)}
              <li>
                <ListRow
                  class="ligne"
                  tabindex={0}
                  role="group"
                  aria-label={rowLabel(e, w)}
                  onopen={onopen ? () => onopen(e.messageId) : undefined}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' && event.target === event.currentTarget) onopen?.(e.messageId);
                  }}
                >
                  {#snippet start()}
                    <span class="heure">{time(e.at)}</span>
                    <span
                      class={['origine', e.origin, { annule: e.undoneAt }]}
                      role="img"
                      aria-label={origin.label}
                    >
                      <origin.icon size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    </span>
                  {/snippet}
                  <div class="grille">
                    <div class="texte">
                      <div class={['objet', { annule: e.undoneAt }]}>{e.subject || 'Sans objet'}</div>
                      <div class="quoi">
                        {w.verb}
                        {#if w.box}
                          <span class="vers"
                            ><span class="pastille" style:background={boxColor(w.box.id)}></span>{w.box
                              .name}</span
                          >
                        {:else if w.spam}
                          <span class="vers spam"
                            ><Ban size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />Spam</span
                          >
                        {/if}
                        {origin.by}{#if e.undoneAt}<span class="quand"
                            >&nbsp;· {undoneText(e, e.undoneAt)}</span
                          >{/if}
                      </div>
                    </div>
                    <div class={['actions', { refuse: refused[e.id] }]}>
                      {#if e.undoneAt}
                        <Badge class="badge-annule">Annulé</Badge>
                      {:else}
                        {#if onopen}
                          <Button
                            variant="fantome"
                            size="petit"
                            icon={Eye}
                            class="ouvrir"
                            onclick={() => onopen(e.messageId)}>Ouvrir</Button
                          >
                        {/if}
                        <Button
                          variant="secondaire"
                          size="petit"
                          icon={Reply}
                          class="annuler"
                          aria-label="Annuler"
                          loading={undoing[e.id]}
                          onclick={() => undo(e)}><span class="mot">Annuler</span></Button
                        >
                      {/if}
                    </div>
                    <div class="refus" aria-live="polite">
                      {#if refused[e.id]}
                        <p>
                          <CircleAlert size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />{refused[
                            e.id
                          ]}
                        </p>
                      {/if}
                    </div>
                  </div>
                </ListRow>
              </li>
            {/each}
          </ul>
        </DayGroup>
      {/each}

      {#if cursor}
        <div class="plus">
          <Button variant="secondaire" size="petit" loading={more} onclick={() => load(cursor)}
            >Plus ancien</Button
          >
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .journal {
    flex: 1;
    min-width: 0;
    padding: 22px 28px 40px;
    overflow-y: auto;
  }
  .colonne {
    display: flex;
    flex-direction: column;
    max-width: 900px;
    margin: 0 auto;
  }
  .entete {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 14px;
  }
  .entete :global(.retour) {
    display: none;
  }
  h1 {
    margin: 0 0 4px;
    font: 500 32px/1.1 var(--serif);
  }
  .entete p {
    margin: 0;
    font-size: 13.5px;
    color: var(--texte-2);
  }
  .colonne :global(.erreur) {
    margin-bottom: 12px;
  }
  .filtres {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    overflow-x: auto;
  }
  .filtres :global(.ia svg) {
    color: var(--ia);
  }
  .aucun {
    margin: 24px 6px;
    font-size: 13.5px;
    color: var(--texte-3);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The shared row, as on the plate: no rule between the lines, a rounded hover. */
  .journal :global(.ligne) {
    min-height: 52px;
    padding: 6px 10px;
    border-bottom: 0;
    border-radius: var(--r-2);
  }
  .heure {
    width: 40px;
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    color: var(--texte-3);
  }
  .origine {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--bordure-forte);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--texte-2);
  }
  .origine.ai,
  .origine.pina {
    border-color: var(--ia-bord);
    background: var(--ia-doux);
    color: var(--ia);
  }
  .origine.annule {
    opacity: 0.5;
  }

  .grille {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 12px;
    align-items: center;
  }
  .objet {
    overflow: hidden;
    font-size: 14px;
    color: var(--texte);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .objet.annule {
    color: var(--texte-3);
    text-decoration: line-through;
  }
  .quoi {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: 12.5px;
    color: var(--texte-3);
  }
  .quand {
    color: var(--texte-2);
  }
  .vers {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--r-1);
    background: var(--surface-2);
    color: var(--texte-2);
    font-size: 11.5px;
  }
  .vers.spam {
    background: var(--danger-doux);
    color: var(--danger);
  }
  .pastille {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  /*
   * « Ouvrir » and « Annuler » on hover or once the row has the keyboard; hidden, they take no width
   * and no Tab stop. A refused undo keeps its button.
   */
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .actions :global(.btn) {
    display: none;
  }
  :global(.ligne:hover) .actions :global(.btn),
  :global(.ligne:focus-within) .actions :global(.btn),
  .actions.refuse :global(.annuler) {
    display: inline-flex;
  }
  .actions.refuse :global(.annuler) {
    opacity: 0.6;
  }
  .refus {
    grid-column: 1 / -1;
  }
  .refus p {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0 0;
    padding: 6px 10px;
    border: 1px solid var(--danger-bord);
    border-radius: var(--r-1);
    background: var(--danger-doux);
    color: var(--danger);
    font-size: 12.5px;
  }
  .refus p :global(svg) {
    flex: none;
  }

  .plus {
    align-self: center;
    margin-top: 14px;
  }
  .attente {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 6px 10px;
  }
  .lignes {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 6px;
  }

  /*
   * Touch: no hover. A tap opens the mail; « Annuler » stays in view (a gesture never replaces it), as
   * a compact icon so the subject keeps the row.
   */
  @media (hover: none) {
    .actions :global(.annuler) {
      position: relative;
      display: inline-flex;
      justify-content: center;
      width: 30px;
      padding: 0;
    }
    /* A 44 px target for the finger around the 30 px button, without widening the row. */
    .actions :global(.annuler::after) {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 44px;
      height: 44px;
      transform: translate(-50%, -50%);
    }
    .actions :global(.annuler .mot) {
      display: none;
    }
    .actions :global(.ouvrir),
    :global(.ligne:focus-within) .actions :global(.ouvrir) {
      display: none;
    }
  }
  @media (max-width: 767.98px) {
    .journal {
      padding: 10px 8px 24px;
    }
    .entete {
      align-items: center;
      padding: 0 6px;
    }
    .entete :global(.retour) {
      display: inline-flex;
    }
    h1 {
      margin: 0;
      font-size: 22px;
    }
    .entete p {
      display: none;
    }
    .filtres {
      padding: 0 8px;
    }
    .journal :global(.ligne) {
      align-items: center;
      min-height: 52px;
    }
    /* Narrow: the subject has the whole row; revealed actions go on their own line under it. */
    .grille {
      grid-template-columns: minmax(0, 1fr);
    }
    .actions :global(.btn) {
      margin-top: 6px;
    }
    /* « annulé à 18:41 » already says it. */
    .actions :global(.badge-annule) {
      display: none;
    }
  }
  @media (max-width: 767.98px) and (hover: none) {
    .grille {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .actions :global(.btn) {
      margin-top: 0;
    }
  }
</style>
