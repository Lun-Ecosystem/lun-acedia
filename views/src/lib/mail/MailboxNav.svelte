<script lang="ts">
  import type { LabelView } from '../types.ts';
  import { Archive, Ban, ChevronDown, ChevronRight, Pencil, Plus, Send, Trash } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';
  import NavGroup from '../ui/NavGroup.svelte';
  import NavLink from '../ui/NavLink.svelte';
  import { boxColor } from './format.ts';

  /** The mail's part of the rail: the boxes, then the folders of Gmail. */

  interface Props {
    view: string;
    boxes: LabelView[];
    onselect: (view: string) => void;
    oncreate: () => void;
  }
  let { view, boxes, onselect, oncreate }: Props = $props();

  let gmail = $state(true);

  const FOLDERS = [
    { id: 'archive', name: 'Archives', icon: Archive },
    { id: 'sent', name: 'Envoyés', icon: Send },
    { id: 'drafts', name: 'Brouillons', icon: Pencil },
    { id: 'spam', name: 'Spam', icon: Ban },
    { id: 'trash', name: 'Corbeille', icon: Trash },
  ];

  const go = (next: string) => (event: MouseEvent) => {
    event.preventDefault();
    onselect(next);
  };
</script>

<NavGroup title="Boîtes">
  {#snippet action()}
    <IconButton icon={Plus} label="Nouvelle boîte" size="petit" onclick={oncreate} />
  {/snippet}
  {#each boxes as box (box.id)}
    <NavLink
      href="#"
      label={box.name}
      color={boxColor(box.id)}
      current={view === `box:${box.id}`}
      onclick={go(`box:${box.id}`)}
    />
  {/each}
</NavGroup>
<NavGroup title="Gmail">
  {#snippet action()}
    <IconButton
      icon={gmail ? ChevronDown : ChevronRight}
      label={gmail ? 'Replier Gmail' : 'Déplier Gmail'}
      size="petit"
      aria-expanded={gmail}
      onclick={() => (gmail = !gmail)}
    />
  {/snippet}
  {#if gmail}
    {#each FOLDERS as folder (folder.id)}
      <NavLink
        href="#"
        label={folder.name}
        icon={folder.icon}
        current={view === folder.id}
        onclick={go(folder.id)}
      />
    {/each}
  {/if}
</NavGroup>
