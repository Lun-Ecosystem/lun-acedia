/** Published name of the views package, integrated by the apps of the Lun' ecosystem. */
export const VIEWS_PACKAGE = '@lun-ecosystem/lunacedia-views';

export { ApiError, httpClient, UnauthorizedError } from './client.ts';
export type {
  AcediaClient,
  AuthorizationRequest,
  EventDraft,
  LinkedClient,
  RuleDraft,
  TaskDraft,
} from './client.ts';
export type * from './types.ts';
export { default as Mailbox } from './mail/Mailbox.svelte';
export { default as Pending } from './mail/Pending.svelte';
export { default as Journal } from './mail/Journal.svelte';
export { default as Agenda } from './agenda/Agenda.svelte';
export { default as Tasks } from './agenda/Tasks.svelte';
export { default as Settings } from './settings/Settings.svelte';
export { default as PinaPanel } from './pina/PinaPanel.svelte';
export * from './ui/index.ts';
