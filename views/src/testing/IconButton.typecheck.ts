/*
 * Compile-time test, checked by `npm run typecheck` (svelte-check) and never run nor packaged
 * (svelte-package only takes src/lib). An icon button without a label must not compile: if `label`
 * ever becomes optional, the `@ts-expect-error` below is unused and svelte-check fails.
 */
import type { ComponentProps } from 'svelte';
import { Archive } from '../lib/ui/Icon.ts';
import type IconButton from '../lib/ui/IconButton.svelte';

type Props = ComponentProps<typeof IconButton>;

export const named: Props = { icon: Archive, label: 'Archiver' };

// @ts-expect-error: `label` is required, it names the button and fills its tooltip.
export const unnamed: Props = { icon: Archive };
