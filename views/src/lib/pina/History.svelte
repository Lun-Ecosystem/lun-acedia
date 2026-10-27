<script lang="ts">
  import { Clock } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import Menu from '../ui/Menu.svelte';
  import type { MenuSection } from '../ui/types.ts';
  import { dayLabel } from './cards.ts';

  /** The days of the thread still kept (plate 01, header): one opens to read, today comes back on top. */

  interface Props {
    days: { day: string; messages: number }[];
    today: string | undefined;
    /** Opens a day; `null` for today. */
    onpick: (day: string | null) => void;
    onopen?: (() => void) | undefined;
  }

  let { days, today, onpick, onopen }: Props = $props();
  let open = $state(false);

  const sections = $derived.by((): MenuSection[] => {
    const past = days.filter((d) => d.day !== today);
    return [
      { items: [{ id: 'today', label: 'Aujourd’hui' }] },
      {
        title: 'Jours passés',
        items: past.length
          ? past.map((d) => ({
              id: d.day,
              label: dayLabel(d.day),
              note: `${d.messages} message${d.messages > 1 ? 's' : ''}`,
            }))
          : [{ id: 'none', label: 'Aucun jour passé gardé', disabled: true }],
      },
    ];
  });
</script>

<Menu
  bind:open={() => open, (v) => ((open = v), v && onopen?.())}
  {sections}
  label="Historique des jours"
  align="end"
  onselect={(id) => onpick(id === 'today' ? null : id)}
>
  {#snippet trigger({ props })}
    <IconButton {...props} icon={Clock} size="petit" label="Historique des jours" />
  {/snippet}
</Menu>
