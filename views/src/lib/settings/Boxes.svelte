<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { LabelView, Role } from '../types.ts';

  interface Props {
    client: AcediaClient;
    labels: LabelView[];
  }
  let { client, labels = $bindable() }: Props = $props();

  let newBox = $state('');
  let newTag = $state('');
  let error = $state<string | null>(null);

  const own = $derived(labels.filter((l) => l.type === 'user'));

  async function create(name: string, role: Role) {
    error = null;
    try {
      const label = await client.createLabel(name.trim(), role);
      labels = [...labels.filter((l) => l.id !== label.id), label];
      if (role === 'box') newBox = '';
      else newTag = '';
    } catch (err) {
      error = errorText(err);
    }
  }

  async function setRole(label: LabelView, value: string) {
    error = null;
    const role = value === 'box' || value === 'tag' ? value : null;
    try {
      const updated = await client.updateLabel(label.id, { role });
      labels = labels.map((l) => (l.id === label.id ? updated : l));
    } catch (err) {
      error = errorText(err);
    }
  }
</script>

<section aria-label="Boîtes et étiquettes">
  <h3>Boîtes et étiquettes</h3>
  <p class="hint">
    Une boîte range le mail (il quitte la réception) ; une étiquette s’ajoute sans le déplacer. Ce sont des
    libellés Gmail.
  </p>
  <ul>
    {#each own as label (label.id)}
      <li>
        <span>{label.name}</span>
        <select
          aria-label={`Rôle de ${label.name}`}
          value={label.role ?? ''}
          onchange={(e) => setRole(label, e.currentTarget.value)}
        >
          <option value="box">Boîte</option>
          <option value="tag">Étiquette</option>
          <option value="">Aucun</option>
        </select>
      </li>
    {/each}
  </ul>
  <form onsubmit={(e) => (e.preventDefault(), create(newBox, 'box'))}>
    <label>Nouvelle boîte <input bind:value={newBox} required /></label>
    <button type="submit" disabled={!newBox.trim()}>Créer la boîte</button>
  </form>
  <form onsubmit={(e) => (e.preventDefault(), create(newTag, 'tag'))}>
    <label>Nouvelle étiquette <input bind:value={newTag} required /></label>
    <button type="submit" disabled={!newTag.trim()}>Créer l’étiquette</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
