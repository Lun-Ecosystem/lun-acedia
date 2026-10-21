/** Shared types of the base ui components (values of plate 10). */

/** Tones of a badge: color, soft background, border. `ia` marks what the AI proposed or did alone. */
export type Tone = 'ok' | 'attention' | 'danger' | 'info' | 'ia' | 'neutre';

/** Five button levels, plus the filled danger of a confirmation. */
export type ButtonVariant = 'principal' | 'doux' | 'secondaire' | 'fantome' | 'danger' | 'danger-plein';

/** Control heights: 28, 34 and 42 px. */
export type Size = 'petit' | 'normal' | 'grand';

/** One choice of a select or a segmented control. */
export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Forced state, honoured by the components for the catalogue page only (`data-etat="survol"`),
 * so that a hover or a keyboard focus can be shown without the pointer.
 */
export type DemoState = 'survol' | 'focus';
