/** Published name of the views package, integrated by the Lun'Anima apps. */
export const VIEWS_PACKAGE = '@lun-ecosystem/lunacedia-views';

export { ApiError, httpClient, UnauthorizedError } from './client.ts';
export type { AcediaClient, EventDraft, RuleDraft, TaskDraft } from './client.ts';
export type * from './types.ts';
export { default as Mailbox } from './mail/Mailbox.svelte';
export { default as Journal } from './mail/Journal.svelte';
export { default as Agenda } from './agenda/Agenda.svelte';
export { default as Settings } from './settings/Settings.svelte';
