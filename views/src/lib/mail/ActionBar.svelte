<script lang="ts">
  import Button from '../ui/Button.svelte';
  import { Archive, Ban, ChevronDown, Eye, Folder, Reply, Trash, X } from '../ui/Icon.ts';
  import IconButton from '../ui/IconButton.svelte';

  /*
   * Toolbar of the reading pane, in groups: close; filing (archive, file, spam, trash); reading
   * (unread). One main action only: Répondre.
   */

  interface Props {
    inTrash: boolean;
    /** « 1 sur 12 ». */
    position: string;
    onback: () => void;
    onfile: (anchor: HTMLElement) => void;
    onarchive: () => void;
    ontrash: () => void;
    onspam: () => void;
    onunread: () => void;
    onreply: () => void;
  }
  let { inTrash, position, onback, onfile, onarchive, ontrash, onspam, onunread, onreply }: Props = $props();
</script>

<div class="barre" role="toolbar" aria-label="Actions sur le mail">
  <IconButton icon={X} label="Fermer" shortcut="Échap" onclick={onback} />
  <span class="sep" aria-hidden="true"></span>
  <IconButton icon={Archive} label="Archiver" shortcut="E" onclick={onarchive} />
  <Button
    variant="secondaire"
    size="petit"
    icon={Folder}
    class="ranger"
    aria-haspopup="menu"
    onclick={(event) => onfile(event.currentTarget)}
    >Ranger dans<ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /></Button
  >
  <IconButton icon={Ban} label="Signaler comme spam" onclick={onspam} />
  {#if !inTrash}<IconButton icon={Trash} label="Corbeille" shortcut="#" onclick={ontrash} />{/if}
  <span class="sep" aria-hidden="true"></span>
  <IconButton icon={Eye} label="Marquer non lu" onclick={onunread} />
  <div class="fin">
    {#if position}<span class="position">{position}</span>{/if}
    <Button
      variant="principal"
      size="petit"
      icon={Reply}
      class="repondre"
      aria-keyshortcuts="R"
      onclick={onreply}>Répondre</Button
    >
  </div>
</div>

<style>
  .barre {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: 52px;
    padding: 0 14px;
    border-bottom: 1px solid var(--bordure);
  }
  .barre :global(.ranger),
  .barre :global(.repondre) {
    height: 32px;
  }
  .sep {
    width: 1px;
    height: 20px;
    margin: 0 6px;
    background: var(--bordure);
  }
  .fin {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }
  .position {
    color: var(--texte-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
</style>
