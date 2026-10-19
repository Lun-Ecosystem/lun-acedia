/**
 * Types shared with the views package (`views/src/lib/types.ts` is a copy kept in sync by
 * `npm run sync-types`): they describe what the API of the front returns.
 */

export interface Address {
  name?: string;
  addr: string;
}

export interface ProposalView {
  /** A box id, `trash`, `spam`, or `null` when no box fits (the proposal may still carry tags). */
  boxId: string | null;
  tagIds: string[];
  confidence: number;
  status: 'pending' | 'auto' | 'accepted' | 'corrected';
}

export interface MailSummary {
  id: string;
  threadId: string;
  from: Address;
  subject: string;
  snippet: string;
  /** ISO 8601, from Gmail's internal date. */
  date: string;
  unread: boolean;
  labels: string[];
  box?: string;
  proposal?: ProposalView;
}

export interface AttachmentMeta {
  /** The MIME part id, stable across fetches (Gmail attachment ids are not). */
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailDetail extends MailSummary {
  to: string;
  cc?: string;
  /** Rendered HTML, to be shown in a sandboxed iframe. */
  html: string;
  attachments: AttachmentMeta[];
}

export interface AgendaEvent {
  kind: 'event';
  id: string;
  calendarId: string;
  title: string;
  /** ISO 8601 instant, or `AAAA-MM-JJ` for an all-day event. */
  start: string;
  /** Exclusive end, same format as `start`. */
  end: string;
  allDay: boolean;
  location?: string;
  /** Minutes before the start (the calendar defaults when the event has none of its own). */
  reminders: number[];
}

export interface AgendaTask {
  kind: 'task';
  id: string;
  listId: string;
  title: string;
  /** `AAAA-MM-JJ`. */
  due?: string;
  done: boolean;
  notes?: string;
}

export type AgendaItem = AgendaEvent | AgendaTask;

export interface MailPage {
  items: MailSummary[];
  cursor?: string;
}
