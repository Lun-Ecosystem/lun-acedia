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
  /** Why the AI proposed this box (160 characters at most); absent for a rule or an older proposal. */
  reason?: string;
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

export type Importance = 'info' | 'normal' | 'urgent';

export interface LunEvent {
  id: string;
  type: string;
  importance: Importance;
  at: string;
  title: string;
  data?: unknown;
}

export interface LabelChange {
  id: string;
  before: string[];
  after: string[];
}

export type BatchOp =
  | { kind: 'file'; boxId: string }
  | { kind: 'archive' }
  | { kind: 'trash' }
  | { kind: 'untrash' }
  | { kind: 'spam' }
  | { kind: 'read'; read: boolean }
  | { kind: 'tags'; add: string[]; remove: string[] };

export interface Draft {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export interface SendAsAddress {
  email: string;
  name?: string;
  primary: boolean;
}

export type Role = 'box' | 'tag';

export interface LabelView {
  id: string;
  name: string;
  type: string;
  role?: Role;
}

export type RuleField = 'from' | 'fromDomain' | 'to' | 'subject';

export type RuleOp = 'equals' | 'contains';

export interface Rule {
  id: number;
  field: RuleField;
  op: RuleOp;
  value: string;
  boxId: string;
  tagIds: string[];
  enabled: boolean;
  position: number;
}

export type Origin = 'rule' | 'ai' | 'user';

export interface JournalEntry {
  id: number;
  at: string;
  messageId: string;
  subject: string;
  origin: Origin;
  action: string;
  before: string[];
  after: string[];
  undoneAt: string | null;
}

export interface Settings {
  /** Confidence (0 to 100) the AI needs to file a mail on its own. */
  threshold: number;
  /** Confidence (0 to 100, never above `threshold`) from which « Tout valider » validates. */
  bulkThreshold: number;
}

export interface GoogleStatus {
  connected: boolean;
  email?: string;
}

/** What happened today (a calendar day in `Europe/Paris`), from the journal minus the undone entries. */
export interface TodayStats {
  /** Mails filed by a rule or by the AI. */
  autoFiled: number;
  validated: number;
  corrected: number;
}

/** A label change recorded in the journal, so that it can be undone. */
export type JournaledChange = LabelChange & { journalId: number };
