<script lang="ts">
  import { onMount } from 'svelte';
  import type { AcediaClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import type { LabelView, Rule, RuleField, RuleOp } from '../types.ts';

  interface Props {
    client: AcediaClient;
    labels: LabelView[];
  }
  let { client, labels }: Props = $props();

  const FIELDS: Record<RuleField, string> = {
    from: 'Expéditeur',
    fromDomain: 'Domaine de l’expéditeur',
    to: 'Destinataire',
    subject: 'Objet',
  };
  const OPS: Record<RuleOp, string> = { equals: 'est', contains: 'contient' };

  let rules = $state<Rule[]>([]);
  let field = $state<RuleField>('from');
  let op = $state<RuleOp>('equals');
  let value = $state('');
  let boxId = $state('');
  let error = $state<string | null>(null);

  const boxes = $derived(labels.filter((l) => l.role === 'box'));
  const name = (id: string) => labels.find((l) => l.id === id)?.name ?? id;

  $effect(() => {
    if (!boxId && boxes[0]) boxId = boxes[0].id;
  });

  onMount(() => {
    client
      .listRules()
      .then((r) => (rules = r))
      .catch((err) => (error = errorText(err)));
  });

  async function add(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    try {
      rules = [...rules, await client.saveRule({ field, op, value: value.trim(), boxId })];
      value = '';
    } catch (err) {
      error = errorText(err);
    }
  }

  async function toggle(rule: Rule) {
    try {
      const saved = await client.saveRule({ ...rule, enabled: !rule.enabled });
      rules = rules.map((r) => (r.id === rule.id ? saved : r));
    } catch (err) {
      error = errorText(err);
    }
  }

  async function remove(rule: Rule) {
    try {
      await client.deleteRule(rule.id);
      rules = rules.filter((r) => r.id !== rule.id);
    } catch (err) {
      error = errorText(err);
    }
  }
</script>

<section aria-label="Règles">
  <h3>Règles</h3>
  <p class="hint">Appliquées avant l’IA, dans l’ordre ; la première qui correspond range le mail.</p>
  <ul>
    {#each rules as rule (rule.id)}
      <li class:off={!rule.enabled}>
        <span>{FIELDS[rule.field]} {OPS[rule.op]} « {rule.value} » → {name(rule.boxId)}</span>
        <button type="button" onclick={() => toggle(rule)}>{rule.enabled ? 'Désactiver' : 'Activer'}</button>
        <button type="button" onclick={() => remove(rule)}>Supprimer</button>
      </li>
    {:else}
      <li class="empty">Aucune règle.</li>
    {/each}
  </ul>
  <form class="rule" onsubmit={add}>
    <label
      >Champ
      <select bind:value={field}>
        {#each Object.entries(FIELDS) as [id, text] (id)}<option value={id}>{text}</option>{/each}
      </select>
    </label>
    <label
      >Condition
      <select bind:value={op}>
        {#each Object.entries(OPS) as [id, text] (id)}<option value={id}>{text}</option>{/each}
      </select>
    </label>
    <label>Valeur <input bind:value required /></label>
    <label
      >Boîte
      <select bind:value={boxId} required>
        {#each boxes as box (box.id)}<option value={box.id}>{box.name}</option>{/each}
      </select>
    </label>
    <button type="submit" disabled={!value.trim() || !boxId}>Ajouter la règle</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .off {
    opacity: 0.55;
  }
  .rule {
    flex-wrap: wrap;
  }
</style>
