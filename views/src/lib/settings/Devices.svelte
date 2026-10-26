<script lang="ts">
  import type { AcediaClient, LinkedClient } from '../client.ts';
  import { errorText } from '../mail/format.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { AppWindow, Copy, ICON_STROKE, Monitor, Plus, Smartphone } from '../ui/Icon.ts';
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
  let code = $state<{ code: string; expiresAt: string; issuedAt: number } | null>(null);
  let now = $state(Date.now());
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
      code = { ...(await client.createPairingCode()), issuedAt: Date.now() };
      now = Date.now();
    } catch (err) {
      error = errorText(err);
    } finally {
      linking = false;
    }
  }

  const left = $derived(code ? Math.max(0, new Date(code.expiresAt).getTime() - now) : 0);
  const expired = $derived(code !== null && left === 0);
  // The bar starts full when the code is shown: the server's clock is not the browser's.
  const share = $derived(code ? left / Math.max(1, new Date(code.expiresAt).getTime() - code.issuedAt) : 0);

  // Ticks only while the window shows a live code.
  $effect(() => {
    if (!code || expired) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  async function copyCode(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast('Code copié');
    } catch {
      toast('Copie impossible : recopier le code à la main', { tone: 'danger' });
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

<Dialog
  bind:open={() => code !== null, (open) => !open && (code = null)}
  title="Code pour un nouvel appareil"
  description={code && !expired
    ? `Saisir ce code sur l’appareil à relier. Il expire à ${time(code.expiresAt)}.`
    : 'Ce code a expiré. En demander un nouveau.'}
  width={400}
>
  {#if code}
    <p class={['chiffres', { expire: expired }]}>
      <span>{code.code.slice(0, 3)}</span><span class="point" aria-hidden="true">·</span><span
        >{code.code.slice(3)}</span
      >
    </p>
    <div class="minuteur" aria-hidden="true"><span style:width="{share * 100}%"></span></div>
    <div class="infos">
      <span>{expired ? 'Expiré' : `${Math.ceil(left / 60_000)} min restante${left > 60_000 ? 's' : ''}`}</span
      >
      <span>Usage unique</span>
    </div>
  {/if}
  {#snippet footer({ close })}
    <Button onclick={close}>Fermer</Button>
    {#if expired}
      <Button variant="doux" loading={linking} onclick={link}>Nouveau code</Button>
    {:else}
      <Button variant="doux" icon={Copy} onclick={() => code && copyCode(code.code)}>Copier</Button>
    {/if}
  {/snippet}
</Dialog>

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
  .chiffres {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin: 6px 0 10px;
    font: 400 34px/1.2 var(--sans);
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    color: var(--texte);
  }
  .chiffres.expire {
    color: var(--texte-3);
    text-decoration: line-through;
  }
  .point {
    color: var(--texte-3);
  }
  .minuteur {
    height: 4px;
    margin: 4px 0 6px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--surface-3);
  }
  .minuteur span {
    display: block;
    height: 100%;
    background: var(--accent-texte);
    transition: width 1s linear;
  }
  .infos {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--texte-3);
  }
  @media (prefers-reduced-motion: reduce) {
    .minuteur span {
      transition: none;
    }
  }
  .erreur {
    margin: 0;
    padding: 10px 18px;
    font-size: 12.5px;
    color: var(--danger);
  }
  @media (max-width: 767.98px) {
    li {
      padding: 12px 14px;
    }
  }
</style>
