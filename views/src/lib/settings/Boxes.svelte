<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import { boxColor, errorText } from '../mail/format.ts';
  import type { LabelView, Role } from '../types.ts';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import Field from '../ui/Field.svelte';
  import { Plus } from '../ui/Icon.ts';
  import Segmented from '../ui/Segmented.svelte';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import TextInput from '../ui/TextInput.svelte';

  /*
   * The Gmail labels of the account and their role, chosen in one click: a box files the mail, a
   * label (tag) is added without moving it, an ignored one is never used by the AI (no role).
   */

  interface Props {
    client: AcediaClient;
    labels: LabelView[];
  }
  let { client, labels = $bindable() }: Props = $props();

  const uid = $props.id();
  const ROLES = [
    { value: 'box', label: 'Boîte' },
    { value: 'tag', label: 'Étiquette' },
    { value: 'ignored', label: 'Ignorée' },
  ];

  let creating = $state(false);
  let name = $state('');
  let role = $state<Role>('box');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let createError = $state<string | undefined>();

  const own = $derived(labels.filter((l) => l.type === 'user'));

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    busy = true;
    createError = undefined;
    try {
      const label = await client.createLabel(name.trim(), role);
      labels = [...labels.filter((l) => l.id !== label.id), label];
      creating = false;
      name = '';
    } catch (err) {
      createError = errorText(err);
    } finally {
      busy = false;
    }
  }

  async function setRole(label: LabelView, value: string) {
    const before = labels;
    const next = value === 'box' || value === 'tag' ? value : null;
    // Shown at once; a refusal puts the previous role back.
    labels = labels.map((l) =>
      l.id === label.id ? { id: l.id, name: l.name, type: l.type, ...(next ? { role: next } : {}) } : l,
    );
    error = null;
    try {
      const updated = await client.updateLabel(label.id, { role: next });
      labels = labels.map((l) => (l.id === label.id ? updated : l));
    } catch (err) {
      labels = before;
      error = errorText(err);
    }
  }
</script>

<SettingsCard
  title="Boîtes et étiquettes"
  description="Une boîte reçoit les mails rangés ; une étiquette s’ajoute sans déplacer."
>
  {#snippet aside()}
    <Button size="petit" icon={Plus} onclick={() => (creating = true)}>Nouvelle</Button>
  {/snippet}
  <ul class="boites">
    {#each own as label (label.id)}
      <li>
        <span class="pastille" style:background={boxColor(label.id)} aria-hidden="true"></span>
        <span class="nom">{label.name}</span>
        <Segmented
          size="petit"
          label="Rôle de {label.name}"
          options={ROLES}
          value={label.role ?? 'ignored'}
          onchange={(value) => setRole(label, value)}
        />
      </li>
    {:else}
      <li class="vide">Aucun libellé Gmail pour l’instant.</li>
    {/each}
  </ul>
  {#if error}<p class="erreur" role="alert">{error}</p>{/if}
</SettingsCard>

<Dialog
  bind:open={creating}
  title="Nouvelle boîte ou étiquette"
  description="Un libellé Gmail est créé sur le compte."
>
  {#snippet children()}
    <form id="{uid}-nouvelle" class="champs" onsubmit={create}>
      <Field label="Nom" error={createError}>
        <TextInput bind:value={name} autocomplete="off" />
      </Field>
      <Segmented
        label="Rôle"
        options={ROLES.slice(0, 2)}
        bind:value={() => role, (v) => (role = v as Role)}
      />
    </form>
  {/snippet}
  {#snippet footer({ close })}
    <Button onclick={close}>Annuler</Button>
    <Button type="submit" form="{uid}-nouvelle" variant="principal" loading={busy} disabled={!name.trim()}
      >Créer</Button
    >
  {/snippet}
</Dialog>

<style>
  .boites {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 8px 18px;
    border-bottom: 1px solid var(--bordure);
    box-sizing: border-box;
  }
  li:last-child {
    border-bottom: 0;
  }
  .pastille {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .nom {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
  }
  .vide {
    color: var(--texte-3);
    font-size: 13px;
  }
  .erreur {
    margin: 0;
    padding: 0 18px 14px;
    font-size: 12.5px;
    color: var(--danger);
  }
  .champs {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  .champs :global(.champ) {
    align-self: stretch;
  }
  @media (max-width: 767.98px) {
    li {
      padding: 8px 14px;
    }
  }
</style>
