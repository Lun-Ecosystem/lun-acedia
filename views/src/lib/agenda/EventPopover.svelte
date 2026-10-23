<script lang="ts">
  import type { AgendaEvent } from '../types.ts';
  import { Bell, Calendar, ICON_STROKE, MapPin, Pencil, Trash, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import Popover from '../ui/Popover.svelte';
  import { addDays, dayName, hours, parseDay, remindersText } from './dates.ts';

  /** Detail bubble of an event (plate 5): when, where, the reminders, its calendar. */

  interface Props {
    event: AgendaEvent;
    anchor: HTMLElement | null;
    open: boolean;
    calendar: string;
    color: string;
    /** Beside the event on a wide screen, under it on a phone. */
    side?: 'right' | 'bottom';
    onedit: () => void;
    ondelete: () => void;
  }
  let {
    event,
    anchor,
    open = $bindable(),
    calendar,
    color,
    side = 'right',
    onedit,
    ondelete,
  }: Props = $props();

  const when = $derived.by(() => {
    if (!event.allDay) return `${dayName(new Date(event.start))} · ${hours(event)}`;
    const last = addDays(parseDay(event.end), -1);
    const first = parseDay(event.start);
    return last.getTime() > first.getTime()
      ? `${dayName(first)} – ${dayName(last)}`
      : `${dayName(first)} · Journée entière`;
  });
</script>

<Popover bind:open {anchor} {side} align="start" width={330} label={event.title}>
  {#snippet children({ close })}
    <div class="detail">
      <div class="outils">
        <IconButton icon={Pencil} label="Modifier" size="petit" onclick={onedit} />
        <IconButton icon={Trash} label="Supprimer" size="petit" onclick={ondelete} />
        <IconButton icon={X} label="Fermer" shortcut="Échap" size="petit" onclick={close} />
      </div>
      <h3><i style:background={color} aria-hidden="true"></i>{event.title}</h3>
      <p class="quand">{when}</p>
      {#if event.location}
        <p class="ligne"><MapPin size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />{event.location}</p>
      {/if}
      {#if event.reminders.length}
        <p class="ligne">
          <Bell size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />{remindersText(event.reminders)}
        </p>
      {/if}
      <p class="ligne"><Calendar size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />{calendar}</p>
    </div>
  {/snippet}
</Popover>

<style>
  .detail {
    padding: 4px 8px 8px;
  }
  .outils {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
    margin: 0 -6px 4px 0;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 2px;
    font: 500 21px/1.2 var(--serif);
  }
  h3 i {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .quand {
    margin: 0;
    padding-left: 22px;
    font-size: 13px;
    color: var(--texte-2);
  }
  .ligne {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin: 9px 0 0;
    font-size: 13px;
    color: var(--texte-2);
  }
  .ligne :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--texte-3);
  }
</style>
