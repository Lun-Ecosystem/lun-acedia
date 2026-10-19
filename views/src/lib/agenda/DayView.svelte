<script lang="ts">
  import type { AgendaItem } from '../types.ts';
  import WeekView from './WeekView.svelte';

  interface Props {
    day: Date;
    items: AgendaItem[];
    today: Date;
    onedit: (item: AgendaItem) => void;
    ontoggle: (item: AgendaItem) => void;
  }
  let { day, ...rest }: Props = $props();
</script>

<!-- A day is a week of one column: same chips, same order. -->
<WeekView days={[day]} {...rest} />
