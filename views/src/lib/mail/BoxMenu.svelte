<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { LabelView } from '../types.ts';
  import { Plus, Sparkles, Trash } from '../ui/Icon.ts';
  import Menu from '../ui/Menu.svelte';
  import type { MenuSection } from '../ui/types.ts';
  import { boxColor } from './format.ts';

  /*
   * « Ranger dans » : the boxes in a layer above the page, filtered as one types, the choice of the AI
   * on top. Opened by its own trigger, or from an element given (a row, a shortcut).
   */

  interface Props {
    boxes: LabelView[];
    /** The box the AI proposes, shown first. */
    suggested?: string | null | undefined;
    /** Adds « Corbeille » (correcting a proposal). */
    withTrash?: boolean | undefined;
    open?: boolean | undefined;
    anchor?: HTMLElement | null | undefined;
    trigger?: Snippet<[{ props: Record<string, unknown> }]> | undefined;
    onpick: (boxId: string) => void;
    oncreate: () => void;
  }
  let {
    boxes,
    suggested = null,
    withTrash = false,
    open = $bindable(false),
    anchor = null,
    trigger,
    onpick,
    oncreate,
  }: Props = $props();

  const sections = $derived.by((): MenuSection[] => {
    const top = boxes.find((b) => b.id === suggested);
    const rest = boxes.filter((b) => b !== top);
    const first = top ? 2 : 1;
    return [
      ...(top
        ? [
            {
              title: 'Suggéré',
              items: [{ id: top.id, label: top.name, icon: Sparkles, tone: 'ia' as const }],
            },
          ]
        : []),
      {
        title: 'Boîtes',
        items: rest.map((b, i) => ({
          id: b.id,
          label: b.name,
          color: boxColor(b.id),
          shortcut: i + first <= 9 ? String(i + first) : undefined,
        })),
      },
      {
        fixed: true,
        items: [
          ...(withTrash ? [{ id: 'trash', label: 'Corbeille', icon: Trash, tone: 'danger' as const }] : []),
          { id: 'nouvelle', label: 'Nouvelle boîte…', icon: Plus },
        ],
      },
    ];
  });
</script>

<Menu
  bind:open
  {sections}
  {anchor}
  {trigger}
  filter="Filtrer les boîtes"
  empty="Aucune boîte de ce nom"
  label="Ranger dans"
  onselect={(id) => (id === 'nouvelle' ? oncreate() : onpick(id))}
/>
