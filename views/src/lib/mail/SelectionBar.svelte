<script lang="ts">
  import Button from '../ui/Button.svelte';
  import Checkbox from '../ui/Checkbox.svelte';
  import { Archive, Eye, Folder, Trash } from '../ui/Icon.ts';

  /** Actions on the ticked mails; it takes the place of the filters while mails are ticked. */

  interface Props {
    count: number;
    onclear: () => void;
    onfile: (anchor: HTMLElement) => void;
    onarchive: () => void;
    onread: () => void;
    ontrash: () => void;
  }
  let { count, onclear, onfile, onarchive, onread, ontrash }: Props = $props();
</script>

<div class="barre" role="toolbar" aria-label="Actions groupées">
  <Checkbox checked aria-label="Désélectionner" onchange={onclear} />
  <b>{count} sélectionné{count > 1 ? 's' : ''}</b>
  <Button
    variant="secondaire"
    size="petit"
    icon={Folder}
    aria-haspopup="menu"
    onclick={(event) => onfile(event.currentTarget)}>Ranger dans…</Button
  >
  <Button variant="fantome" size="petit" icon={Archive} onclick={onarchive}>Archiver</Button>
  <Button variant="fantome" size="petit" icon={Eye} onclick={onread}>Marquer lu</Button>
  <Button variant="fantome" size="petit" icon={Trash} onclick={ontrash}>Corbeille</Button>
  <span class="aide">Échap pour désélectionner</span>
</div>

<style>
  .barre {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    margin: 10px 14px 4px;
    padding: 6px 14px;
    box-sizing: border-box;
    background: var(--surface-2);
    border: 1px solid var(--bordure-forte);
    border-radius: var(--r-2);
  }
  b {
    margin: 0 10px 0 6px;
    font-weight: 400;
  }
  .aide {
    margin-left: auto;
    color: var(--texte-3);
    font-size: 12.5px;
  }
  @media (max-width: 767.98px) {
    .aide {
      display: none;
    }
  }
</style>
