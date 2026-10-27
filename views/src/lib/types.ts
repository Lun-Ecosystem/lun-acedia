// Copie de server/src/types.ts, à ne pas modifier : lancer `npm run sync-types -w @lun-ecosystem/lunacedia-views`.
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

/** A Gmail draft as the composer and Pina see it; `replyTo.id` is the Message-ID of the mail answered. */
export interface DraftView {
  id: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  replyTo?: { id: string; threadId: string };
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

export type Origin = 'rule' | 'ai' | 'user' | 'pina';

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

/** The AI providers the user can pick; `custom` is any OpenAI-compatible endpoint. */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'mistral' | 'custom';

/** A provider as the settings show it (`GET /api/llm/providers`): never more of its key than the last 4 characters. */
export interface ProviderView {
  id: ProviderId;
  label: string;
  /** `credit`: the key works but its credit is spent. */
  state: 'ok' | 'refused' | 'credit' | 'absent';
  /** Absent when the key has 4 characters or fewer. */
  last4?: string;
  /** Declared expiry, `AAAA-MM-JJ`. */
  expires?: string;
  /** Where the key in service comes from: saved in the settings or declared in `.env`. */
  source?: 'saved' | 'env';
  /** The custom endpoint's address, without credentials. */
  baseUrl?: string;
}

export interface ModelInfo {
  provider: ProviderId;
  id: string;
  label: string;
  /** The provider documents tool calling for this model. */
  tools: boolean;
  /** Dollars per million tokens; absent when no official price was found (shown « prix inconnu »). */
  price?: { input: number; output: number };
}

/** Marker by output price: € under $2, €€ from $2 to under $15, €€€ beyond; `null` without a price. */
export type CostTier = '€' | '€€' | '€€€' | null;

/** A model offered for a use (`GET /api/llm/models`), with its cost marker. */
export type ModelOffer = ModelInfo & { tier: CostTier };

/** The model of a use (`GET /api/llm/choice`); `null` while nothing is chosen nor configured. */
export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

/** What the screen shows when CrOliX asks Pina (`POST /api/pina/messages`): « ce mail » is `mailId`. */
export interface ScreenContext {
  screen: 'mail' | 'pending' | 'agenda' | 'tasks' | 'journal' | 'settings' | 'compose';
  mailId?: string;
  /** `AAAA-MM-JJ`. */
  day?: string;
  listId?: string;
  draftId?: string;
}

export type PinaCardStatus = 'pending' | 'done' | 'refused' | 'failed' | 'expired';

/** A write Pina proposed (or did, in « faire tout de suite »), as a card of the day's thread. */
export interface PinaCard {
  id: number;
  day: string;
  /** Id of the user message that started the turn: the cards of one turn are decided together. */
  turn: number;
  createdAt: string;
  callId: string;
  /** Name of the catalogue action (`task.create`). */
  action: string;
  input: unknown;
  effect: string;
  status: PinaCardStatus;
  result: unknown;
  /** Why a `failed` card failed, as the server said it. */
  error: string | null;
  /** Present when « Annuler » can undo a `done` card. */
  inverse: unknown;
  decidedAt: string | null;
  /** CrOliX changed the input (« Modifier ») before accepting. */
  edited: boolean;
}

/** One stored message of the thread; `turn` ties Pina's messages to the request they answer. */
export type PinaMessage =
  | { role: 'user'; text: string; context?: ScreenContext; turn?: number }
  | {
      role: 'assistant';
      text: string;
      toolCalls: { id: string; name: string; input: unknown }[];
      turn?: number;
    }
  | { role: 'tool'; callId: string; content: string; isError: boolean; turn?: number };

/** A day of Pina's thread (`GET /api/pina/today`, `/days/:day`); `pending` counts its waiting cards. */
export interface PinaThread {
  day: string;
  messages: { id: number; at: string; message: PinaMessage }[];
  cards: PinaCard[];
  pending: number;
}

export interface PinaSettings {
  mode: 'validate' | 'immediate';
  instructions: string;
  retentionDays: number;
  dailyCapUsd: number;
}
