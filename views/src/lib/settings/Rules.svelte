<script lang="ts">
  import type { AcediaClient } from '../client.ts';
  import { boxColor, errorText } from '../mail/format.ts';
  import type { LabelView, Rule, RuleField, RuleOp } from '../types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import {
    ArrowDown,
    ArrowUp,
    ChevronDown,
    Ellipsis,
    GripVertical,
    ICON_STROKE,
    Pause,
    Play,
    Plus,
    Trash,
  } from '../ui/Icon.ts';
  import Menu from '../ui/Menu.svelte';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import TextInput from '../ui/TextInput.svelte';
  import type { MenuSection } from '../ui/types.ts';

  /*
   * The rules, applied before the AI in their order, read as sentences. The order changes by dragging
   * the handle, or with « Monter » and « Descendre » in the menu of a rule (keyboard). A new rule is
   * written by completing a sentence.
   */

  interface Props {
    client: AcediaClient;
    labels: LabelView[];
    rules: Rule[];
  }
  let { client, labels, rules = $bindable() }: Props = $props();

  /** Article and noun of each field: « Si l’expéditeur », « Si le domaine de l’expéditeur ». */
  const FIELDS: Record<RuleField, [string, string]> = {
    from: ['l’', 'expéditeur'],
    fromDomain: ['le ', 'domaine de l’expéditeur'],
    to: ['le ', 'destinataire'],
    subject: ['l’', 'objet'],
  };
  const OPS: Record<RuleOp, string> = { equals: 'est', contains: 'contient' };

  let field = $state<RuleField>('from');
  let op = $state<RuleOp>('contains');
  let value = $state('');
  let boxId = $state('');
  let adding = $state(false);
  let error = $state<string | null>(null);
  let removing = $state<Rule | null>(null);

  const boxes = $derived(labels.filter((l) => l.role === 'box'));
  const box = (id: string) => labels.find((l) => l.id === id);
  const target = $derived(box(boxId));

  $effect(() => {
    if (!boxId && boxes[0]) boxId = boxes[0].id;
  });

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!value.trim() || !boxId || adding) return;
    adding = true;
    error = null;
    try {
      rules = [...rules, await client.saveRule({ field, op, value: value.trim(), boxId })];
      value = '';
    } catch (err) {
      error = errorText(err);
    } finally {
      adding = false;
    }
  }

  async function update(rule: Rule, patch: Partial<Rule>) {
    error = null;
    try {
      const saved = await client.saveRule({ ...rule, ...patch });
      rules = rules.map((r) => (r.id === rule.id ? saved : r));
    } catch (err) {
      error = errorText(err);
    }
  }

  /** Moves a rule from one place to another: the rules between take each other's positions. */
  async function move(from: number, to: number) {
    if (from === to || to < 0 || to >= rules.length) return;
    const before = rules;
    const order = [...rules];
    order.splice(to, 0, ...order.splice(from, 1));
    const slots = rules.map((r) => r.position);
    const next = order.map((r, i) => ({ ...r, position: slots[i]! }));
    const changed = next.filter((r, i) => r.position !== order[i]!.position);
    rules = next;
    error = null;
    try {
      await Promise.all(changed.map((r) => client.saveRule(r)));
    } catch (err) {
      rules = before;
      error = errorText(err);
    }
  }

  async function remove() {
    const rule = removing!;
    await client.deleteRule(rule.id);
    rules = rules.filter((r) => r.id !== rule.id);
  }

  const menu = (rule: Rule, i: number): MenuSection[] => [
    {
      items: [
        { id: 'up', label: 'Monter', icon: ArrowUp, disabled: i === 0, onselect: () => move(i, i - 1) },
        {
          id: 'down',
          label: 'Descendre',
          icon: ArrowDown,
          disabled: i === rules.length - 1,
          onselect: () => move(i, i + 1),
        },
        {
          id: 'toggle',
          label: rule.enabled ? 'Désactiver' : 'Activer',
          icon: rule.enabled ? Pause : Play,
          onselect: () => update(rule, { enabled: !rule.enabled }),
        },
      ],
    },
  ];

  const pick = <T extends string>(entries: Record<T, string>, set: (v: T) => void): MenuSection[] => [
    {
      items: (Object.entries(entries) as [T, string][]).map(([id, label]) => ({
        id,
        label,
        onselect: () => set(id),
      })),
    },
  ];
  const fieldNames = Object.fromEntries(
    Object.entries(FIELDS).map(([k, v]) => [k, (v as [string, string])[1]]),
  ) as Record<RuleField, string>;

  /* Dragging by the handle: the row becomes draggable only while the handle is held. */
  let grabbed = $state<number | null>(null);
  let dragged = $state<number | null>(null);
  let over = $state<number | null>(null);

  function drop(to: number) {
    const from = dragged;
    dragged = over = grabbed = null;
    if (from !== null) void move(from, to);
  }
</script>

{#snippet sentence(rule: Rule)}
  {@const [article, noun] = FIELDS[rule.field]}
  {@const into = box(rule.boxId)}
  <span class="phrase"
    >Si {article}<b>{noun}</b>
    {OPS[rule.op]} «&nbsp;<b>{rule.value}</b>&nbsp;», ranger dans
    <span class="boite"
      ><span class="pastille" style:background={boxColor(rule.boxId)} aria-hidden="true"></span>{into?.name ??
        rule.boxId}</span
    ></span
  >
{/snippet}

<SettingsCard
  title="Règles"
  description="Appliquées avant l’IA, dans l’ordre ; la première qui correspond range le mail."
>
  {#if rules.length}
    <ol class="regles">
      {#each rules as rule, i (rule.id)}
        <li
          class={['regle', { off: !rule.enabled, tire: dragged === i, dessus: over === i && dragged !== i }]}
          draggable={grabbed === rule.id}
          ondragstart={(e) => {
            dragged = i;
            e.dataTransfer?.setData('text/plain', String(rule.id));
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          }}
          ondragover={(e) => {
            if (dragged === null) return;
            e.preventDefault();
            over = i;
          }}
          ondrop={(e) => {
            e.preventDefault();
            drop(i);
          }}
          ondragend={() => (dragged = over = grabbed = null)}
        >
          <span
            class="poignee"
            aria-hidden="true"
            onpointerdown={() => (grabbed = rule.id)}
            onpointerup={() => (grabbed = null)}
          >
            <GripVertical size={16} strokeWidth={ICON_STROKE} />
          </span>
          <span class="num" aria-hidden="true">{i + 1}</span>
          {@render sentence(rule)}
          {#if !rule.enabled}<Badge>Désactivée</Badge>{/if}
          <span class="actions">
            <Menu sections={menu(rule, i)} align="end" label={`Actions de la règle ${i + 1}`}>
              {#snippet trigger({ props })}
                <IconButton {...props} icon={Ellipsis} label={`Actions de la règle ${i + 1}`} size="petit" />
              {/snippet}
            </Menu>
            <IconButton
              icon={Trash}
              label={`Supprimer la règle ${i + 1}`}
              size="petit"
              onclick={() => (removing = rule)}
            />
          </span>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="vide">Aucune règle : l’IA propose pour chaque nouveau mail.</p>
  {/if}

  <form class="nouvelle" onsubmit={add}>
    <Plus size={14} strokeWidth={ICON_STROKE} aria-hidden="true" class="plus" />
    <span>Si {FIELDS[field][0]}</span>
    <Menu sections={pick(fieldNames, (v) => (field = v))}>
      {#snippet trigger({ props })}
        <Button {...props} size="petit" aria-label={`Champ : ${FIELDS[field][1]}`}
          >{FIELDS[field][1]}<ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" /></Button
        >
      {/snippet}
    </Menu>
    <Menu sections={pick(OPS, (v) => (op = v))}>
      {#snippet trigger({ props })}
        <Button {...props} size="petit" aria-label={`Condition : ${OPS[op]}`}
          >{OPS[op]}<ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" /></Button
        >
      {/snippet}
    </Menu>
    <TextInput
      size="petit"
      class="valeur"
      aria-label="Valeur"
      placeholder="adresse, domaine ou mot"
      autocomplete="off"
      bind:value
    />
    <span>ranger dans</span>
    <Menu
      sections={[
        {
          items: boxes.map((b) => ({
            id: b.id,
            label: b.name,
            color: boxColor(b.id),
            onselect: () => (boxId = b.id),
          })),
        },
      ]}
    >
      {#snippet trigger({ props })}
        <Button {...props} size="petit" aria-label={`Boîte : ${target?.name ?? 'aucune'}`}>
          {#if target}<span class="pastille" style:background={boxColor(target.id)} aria-hidden="true"
            ></span>{/if}
          {target?.name ?? 'Choisir une boîte'}<ChevronDown
            size={14}
            strokeWidth={ICON_STROKE}
            aria-hidden="true"
          />
        </Button>
      {/snippet}
    </Menu>
    <Button
      type="submit"
      variant="principal"
      size="petit"
      class="ajouter"
      loading={adding}
      disabled={!value.trim() || !boxId}>Ajouter</Button
    >
  </form>
  {#if error}<p class="erreur" role="alert">{error}</p>{/if}
</SettingsCard>

<ConfirmDialog
  bind:open={() => removing !== null, (open) => !open && (removing = null)}
  title="Supprimer cette règle ?"
  message="Les mails déjà rangés ne bougent pas ; les suivants passent à la règle suivante, puis à l’IA."
  confirmLabel="Supprimer la règle"
  onconfirm={remove}
/>

<style>
  .regles {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .regle {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 8px 12px 8px 14px;
    border-bottom: 1px solid var(--bordure);
    border-top: 2px solid transparent;
    margin-top: -2px;
    box-sizing: border-box;
    font-size: 13.5px;
    color: var(--texte-2);
  }
  .regle.tire {
    opacity: 0.45;
  }
  .regle.dessus {
    border-top-color: var(--accent-texte);
  }
  .off .phrase {
    opacity: 0.55;
  }
  .poignee {
    display: grid;
    place-items: center;
    flex: none;
    width: 18px;
    height: 28px;
    color: var(--texte-3);
    cursor: grab;
    touch-action: none;
  }
  .poignee:active {
    cursor: grabbing;
  }
  .num {
    display: grid;
    place-items: center;
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--surface-3);
    font-size: 11px;
    color: var(--texte-2);
  }
  .phrase {
    flex: 1;
    min-width: 0;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .phrase b {
    font-weight: 400;
    color: var(--texte);
  }
  .boite {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    margin-left: 2px;
    border-radius: var(--r-1);
    background: var(--surface-3);
    color: var(--texte);
    font-size: 12px;
    vertical-align: middle;
  }
  .pastille {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .actions {
    display: flex;
    flex: none;
    gap: 2px;
    margin-left: auto;
  }
  .vide {
    margin: 0;
    padding: 14px 18px;
    border-bottom: 1px solid var(--bordure);
    font-size: 13px;
    color: var(--texte-3);
  }
  .nouvelle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 14px 18px;
    border-radius: 0 0 var(--r-3) var(--r-3);
    background: color-mix(in srgb, var(--surface-2) 40%, transparent);
    font-size: 13.5px;
    color: var(--texte-2);
  }
  .nouvelle :global(.plus) {
    color: var(--texte-3);
  }
  .nouvelle :global(.valeur) {
    flex: 1 1 150px;
    min-width: 150px;
    max-width: 220px;
    height: 28px;
    border-color: var(--accent-bord);
  }
  .nouvelle :global(.valeur input) {
    font-size: 13px;
  }
  .nouvelle :global(.ajouter) {
    margin-left: auto;
  }
  .erreur {
    margin: 0;
    padding: 0 18px 14px;
    font-size: 12.5px;
    color: var(--danger);
  }
  @media (max-width: 767.98px) {
    .regle {
      align-items: flex-start;
      padding: 10px 8px 10px 10px;
    }
    .poignee {
      display: none;
    }
    .nouvelle {
      padding: 14px;
    }
    .nouvelle :global(.valeur) {
      max-width: none;
    }
  }
</style>
