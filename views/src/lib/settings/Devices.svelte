<script lang="ts">
  import type { AcediaClient, LinkedClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import { AppWindow, ICON_STROKE, Monitor, Plus, Smartphone } from '../ui/Icon.ts';
  import SettingsCard from '../ui/SettingsCard.svelte';
  import { toast } from '../ui/toasts.svelte.ts';

  /*
   * What holds an access to Lun'Acedia: each device and app, since when (the server keeps no last
   * activity), this browser marked. Removing one asks first and says what follows.
   */

  interface Props {
    client: AcediaClient;
    clients: LinkedClient[];
    /** Called once this browser's own access is revoked: its token no longer works. */
    onSelfRevoked?: (() => void) | undefined;
  }
  let { client, clients = $bindable(), onSelfRevoked }: Props = $props();

  let removing = $state<LinkedClient | null>(null);
  let code = $state<{ code: string; expiresAt: string } | null>(null);
  let linking = $state(false);
  let error = $state<string | null>(null);

  async function revoke() {
    const c = removing!;
    await client.revokeClient(c.id);
    if (c.current && onSelfRevoked) {
      // The token is dead: no further call, the host app goes back to pairing.
      onSelfRevoked();
      return;
    }
    removedAt = clients.findIndex((x) => x.id === c.id);
    clients = clients.filter((x) => x.id !== c.id);
    toast(`Accès retiré : ${c.current ? 'ce navigateur' : c.name}`);
    // No handover: one call with the dead token lets the host's 401 handling take over.
    if (c.current) void client.listClients().catch(() => {});
  }

  let card = $state<HTMLElement | null>(null);
  /** Index of the access just removed: the focus goes to the row now in its place. */
  let removedAt = $state<number | null>(null);

  function focusAfterRemoval() {
    if (removedAt === null) return null;
    const buttons = card?.querySelectorAll<HTMLElement>('li button') ?? [];
    const next = buttons[Math.min(removedAt, buttons.length - 1)];
    removedAt = null;
    return next ?? card?.querySelector<HTMLElement>('header button');
  }

  /** The server only knows « device » or « app »: a phone is told by the name its browser gave. */
  const PHONE = /iphone|ipad|android|mobile|téléphone|smartphone/i;
  const iconOf = (c: LinkedClient) =>
    c.kind === 'app' ? AppWindow : PHONE.test(c.name) ? Smartphone : Monitor;

  async function link() {
    error = null;
    linking = true;
    try {
      code = await client.createPairingCode();
    } catch (err) {
      error = errorText(err);
    } finally {
      linking = false;
    }
  }

  const thisYear = new Date().getFullYear();
  /** « 18 oct. », with the year when it is not this one. */
  const date = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      ...(d.getFullYear() === thisYear ? {} : { year: 'numeric' }),
    });
  };
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const since = (c: LinkedClient) =>
    c.kind === 'app' ? `Application · reliée le ${date(c.createdAt)}` : `Relié le ${date(c.createdAt)}`;

  const confirmation = $derived.by(() => {
    if (!removing) return { title: '', message: '', label: '' };
    if (removing.current)
      return {
        title: 'Retirer ce navigateur ?',
        message: "Ce navigateur perdra l’accès à Lun'Acedia. Un nouveau code sera nécessaire pour le relier.",
        label: 'Retirer ce navigateur',
      };
    if (removing.kind === 'app')
      return {
        title: `Retirer ${removing.name} ?`,
        message:
          "Cette application perdra l’accès à Lun'Acedia. Elle devra demander une nouvelle autorisation.",
        label: 'Retirer l’application',
      };
    return {
      title: `Retirer ${removing.name} ?`,
      message: "Cet appareil perdra l’accès à Lun'Acedia. Un nouveau code sera nécessaire pour le relier.",
      label: 'Retirer l’appareil',
    };
  });
</script>

<div bind:this={card}>
  <SettingsCard title={`${clients.length} accès`}>
    {#snippet aside()}
      <Button size="petit" icon={Plus} loading={linking} onclick={link}>Relier un appareil</Button>
    {/snippet}
    {#if code}
      <div class="code" role="status">
        <div>
          <div class="titre">Code de liaison</div>
          <div class="aide">À saisir sur le nouvel appareil. Expire à {time(code.expiresAt)}.</div>
        </div>
        <span class="chiffres">{code.code}</span>
      </div>
    {/if}
    {#if error}<p class="erreur" role="alert">{error}</p>{/if}
    <ul>
      {#each clients as c (c.id)}
        {@const Icon = iconOf(c)}
        <li>
          <span class="ico" aria-hidden="true"><Icon size={16} strokeWidth={ICON_STROKE} /></span>
          <div class="texte">
            <div class="nom">
              <b>{c.name}</b>
              {#if c.current}<Badge tone="ok">Ce navigateur</Badge>{/if}
            </div>
            <small>{since(c)}</small>
          </div>
          <Button variant="fantome" size="petit" onclick={() => (removing = c)}>Retirer</Button>
        </li>
      {/each}
    </ul>
  </SettingsCard>
</div>

<ConfirmDialog
  bind:open={() => removing !== null, (open) => !open && (removing = null)}
  title={confirmation.title}
  message={confirmation.message}
  confirmLabel={confirmation.label}
  onconfirm={revoke}
  returnFocus={focusAfterRemoval}
/>

<style>
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--bordure);
  }
  li:last-child {
    border-bottom: 0;
  }
  .ico {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: var(--r-2);
    background: var(--surface-3);
    color: var(--texte-2);
  }
  .texte {
    flex: 1;
    min-width: 0;
  }
  .nom {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }
  b {
    font-weight: 500;
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
    font-size: 12.5px;
    color: var(--texte-3);
  }
  .code {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--bordure);
    background: var(--accent-doux);
  }
  .code > div {
    flex: 1;
  }
  .titre {
    font-size: 14px;
  }
  .aide {
    margin-top: 2px;
    font-size: 12.5px;
    color: var(--texte-2);
  }
  .chiffres {
    font: 500 30px/1 var(--serif);
    letter-spacing: 0.24em;
    font-variant-numeric: tabular-nums;
  }
  .erreur {
    margin: 0;
    padding: 10px 18px;
    font-size: 12.5px;
    color: var(--danger);
  }
  @media (max-width: 767.98px) {
    li,
    .code {
      padding: 12px 14px;
    }
  }
</style>
