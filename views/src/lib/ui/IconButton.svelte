<script lang="ts">
  import { Tooltip } from 'bits-ui';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { ICON_STROKE, type IconComponent } from './Icon.ts';
  import Kbd from './Kbd.svelte';
  import type { ButtonVariant, Size } from './types.ts';

  type Props = Omit<HTMLButtonAttributes, 'children' | 'aria-label' | 'title'> & {
    icon: IconComponent;
    /** Required: name of the action, read by screen readers and shown in the tooltip. */
    label: string;
    /** Shortcut shown in the tooltip (`E`, `#`). */
    shortcut?: string | undefined;
    size?: Size | undefined;
    variant?: ButtonVariant | undefined;
  };

  let {
    icon: Icon,
    label,
    shortcut,
    size = 'normal',
    variant = 'fantome',
    type = 'button',
    class: className,
    ...rest
  }: Props = $props();
</script>

<Tooltip.Provider delayDuration={350} skipDelayDuration={250}>
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          {...rest}
          {type}
          class={['btn', variant, size, className]}
          aria-label={label}
          aria-keyshortcuts={shortcut}
        >
          <Icon size={size === 'petit' ? 15 : 16} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content sideOffset={6}>
        {#snippet child({ wrapperProps, props })}
          <div {...wrapperProps}>
            <div {...props} class="bulle">
              {label}
              {#if shortcut}<Kbd>{shortcut}</Kbd>{/if}
            </div>
          </div>
        {/snippet}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
</Tooltip.Provider>

<style>
  .btn {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--r-2);
    background: none;
    color: var(--texte-2);
    cursor: pointer;
    transition:
      background-color 120ms ease,
      border-color 120ms ease,
      color 120ms ease;
  }
  .petit {
    width: 28px;
    height: 28px;
    border-radius: var(--r-1);
  }
  .grand {
    width: 42px;
    height: 42px;
  }

  /* Each hover names its border: base.css still styles bare buttons for the views not yet redone. */
  .fantome:enabled:hover,
  .fantome[data-etat='survol'] {
    background: var(--survol);
    border-color: transparent;
    color: var(--texte);
  }
  .fantome:enabled:active {
    background: var(--appui);
  }
  .secondaire {
    background: var(--surface-2);
    border-color: var(--bordure-forte);
    color: var(--texte);
  }
  .secondaire:enabled:hover,
  .secondaire[data-etat='survol'] {
    background: var(--surface-3);
    border-color: var(--bordure-forte);
  }
  .principal {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--texte);
  }
  .principal:enabled:hover,
  .principal[data-etat='survol'] {
    background: var(--accent-survol);
    border-color: var(--accent-survol);
  }
  .doux {
    background: var(--accent-doux);
    border-color: var(--accent-bord);
    color: var(--accent-texte);
  }
  .doux:enabled:hover,
  .doux[data-etat='survol'] {
    background: color-mix(in srgb, var(--accent) 36%, transparent);
    border-color: var(--accent-bord);
    color: var(--texte);
  }
  .danger {
    border-color: var(--danger-bord);
    color: var(--danger);
  }
  .danger:enabled:hover,
  .danger[data-etat='survol'] {
    background: var(--danger-doux);
    border-color: var(--danger-bord);
  }
  .danger-plein {
    background: var(--danger-plein);
    border-color: var(--danger-plein);
    color: var(--texte);
  }

  .btn:focus-visible,
  .btn[data-etat='focus'] {
    outline: 2px solid var(--accent-texte);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }

  .bulle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 9px;
    border-radius: var(--r-1);
    background: var(--surface-3);
    color: var(--texte);
    font: 400 12px/1.4 var(--sans);
    white-space: nowrap;
    box-shadow: var(--ombre-2);
  }
</style>
