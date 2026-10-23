import type {
  AgendaEvent,
  AgendaItem,
  AgendaTask,
  BatchOp,
  Draft,
  GoogleStatus,
  JournalEntry,
  JournaledChange,
  LabelChange,
  LabelView,
  LunEvent,
  MailDetail,
  MailPage,
  ProposalView,
  Role,
  Rule,
  RuleField,
  RuleOp,
  SendAsAddress,
  Settings,
  TodayStats,
} from './types.ts';

export interface RuleDraft {
  id?: number;
  field: RuleField;
  op: RuleOp;
  value: string;
  boxId: string;
  tagIds?: string[];
  enabled?: boolean;
}

export interface EventDraft {
  /** Absent for a new event. */
  id?: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** Minutes before the start; `null` for the calendar defaults. */
  reminders?: number[] | null;
}

export interface TaskDraft {
  /** Absent for a new task. */
  id?: string;
  listId: string;
  title: string;
  due?: string | null;
  notes?: string;
}

/** A device or an app that holds a token; `current` is the one asking. */
export interface LinkedClient {
  id: number;
  name: string;
  kind: 'device' | 'app';
  createdAt: string;
  current: boolean;
}

/**
 * The Anthropic key in service, as `GET /api/anthropic-key` describes it: never the key itself, only
 * its last 4 characters. `credit` means the key works but its credit is spent.
 */
export interface AnthropicKeyStatus {
  state: 'ok' | 'refused' | 'credit' | 'absent';
  last4?: string;
  /** Declared expiry, `AAAA-MM-JJ`. */
  expires?: string;
  /** Where the key in service comes from: saved in the settings or declared in `.env`. */
  source?: 'saved' | 'env';
}

/** An app asking for access (`GET /lun/v1/authorize`), as the authorization page received it. */
export interface AuthorizationRequest {
  client: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
}

/**
 * Everything the views can ask of Lun'Acedia. The views know only this interface: the standalone
 * app and each app that integrates the views give them an implementation (usually `httpClient`).
 */
export interface AcediaClient {
  listMail(view: string, opts?: { q?: string; cursor?: string }): Promise<MailPage>;
  getMail(id: string): Promise<MailDetail>;
  /** An attachment's content, by its part id (`AttachmentMeta.id`). */
  attachment(id: string, partId: string): Promise<Blob>;
  file(id: string, boxId: string): Promise<JournaledChange>;
  trash(id: string): Promise<JournaledChange>;
  untrash(id: string): Promise<LabelChange>;
  archive(id: string): Promise<JournaledChange>;
  spam(id: string): Promise<JournaledChange>;
  setTags(id: string, add: string[], remove: string[]): Promise<LabelChange>;
  markRead(id: string, read: boolean): Promise<LabelChange>;
  /** `journalId` is present for the filing, archive, trash and spam operations. */
  batch(ids: string[], op: BatchOp): Promise<(LabelChange & { journalId?: number })[]>;
  send(draft: Draft): Promise<{ id: string; threadId: string }>;
  sendAs(replyTo?: string): Promise<{ addresses: SendAsAddress[]; default: string }>;
  validate(id: string): Promise<ProposalView & { journalId: number }>;
  correct(
    id: string,
    boxId: string,
    tagIds: string[],
    opts?: { rememberSender?: boolean },
  ): Promise<ProposalView & { journalId: number }>;
  listLabels(): Promise<LabelView[]>;
  createLabel(name: string, role: Role): Promise<LabelView>;
  updateLabel(id: string, patch: { role: Role | null }): Promise<LabelView>;
  listRules(): Promise<Rule[]>;
  saveRule(rule: RuleDraft): Promise<Rule>;
  deleteRule(id: number): Promise<void>;
  journal(cursor?: number): Promise<{ items: JournalEntry[]; cursor?: number }>;
  undo(journalId: number): Promise<LabelChange>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  todayStats(): Promise<TodayStats>;
  agenda(from: string, to: string): Promise<AgendaItem[]>;
  undatedTasks(): Promise<AgendaTask[]>;
  /** Every task of every list, done ones included. */
  allTasks(): Promise<AgendaTask[]>;
  listCalendars(): Promise<{ id: string; title: string }[]>;
  listTaskLists(): Promise<{ id: string; title: string }[]>;
  saveEvent(item: EventDraft): Promise<AgendaEvent>;
  deleteEvent(calendarId: string, id: string): Promise<void>;
  saveTask(item: TaskDraft): Promise<AgendaTask>;
  completeTask(listId: string, id: string, done?: boolean): Promise<AgendaTask>;
  deleteTask(listId: string, id: string): Promise<void>;
  googleStatus(): Promise<GoogleStatus>;
  googleAuthUrl(): Promise<{ url: string }>;
  googleDisconnect(): Promise<void>;
  createPairingCode(): Promise<{ code: string; expiresAt: string }>;
  listClients(): Promise<LinkedClient[]>;
  revokeClient(id: number): Promise<void>;
  /** Records the decision of a linked device; returns where to send the browser back. */
  authorize(req: AuthorizationRequest & { decision: 'allow' | 'deny' }): Promise<{ redirect: string }>;
  getAnthropicKey(): Promise<AnthropicKeyStatus>;
  /** Checks the key with Anthropic, then saves it; rejects (nothing changed) when refused or unreachable. */
  saveAnthropicKey(key: string, expires?: string): Promise<AnthropicKeyStatus>;
  /** State of the service (`GET /lun/v1/health`): sorting active, paused, or degraded (`paused` then tells a pause). */
  health(): Promise<{ status: 'ok' | 'paused' | 'degraded'; reason?: string; paused?: boolean }>;
  /** Pauses everything automatic (the AI and the rules); what is asked by hand still runs. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Calls `onEvent` for each satellite event; returns the function that stops listening. */
  subscribe(onEvent: (e: LunEvent) => void): () => void;
}

/** An error answered by Lun'Acedia, with its HTTP status (409: the mail changed since…). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The token was refused (revoked or never paired): the device has to pair again. */
export class UnauthorizedError extends ApiError {
  constructor(message: string) {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

const enc = encodeURIComponent;

/** The `AcediaClient` over HTTP, for a server at `baseUrl` and a paired client token. */
export function httpClient(opts: { baseUrl: string; token: string; fetch?: typeof fetch }): AcediaClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const headers = { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' };

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await doFetch(`${base}${path}`, init);
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const message = (json as { error?: string } | undefined)?.error ?? `Erreur ${res.status}`;
      throw res.status === 401 ? new UnauthorizedError(message) : new ApiError(res.status, message);
    }
    return json as T;
  }
  const items = async <T>(path: string) => (await call<{ items: T[] }>('GET', path)).items;

  return {
    listMail(view, o = {}) {
      const q = new URLSearchParams(o.q ? { q: o.q } : { view });
      if (o.cursor) q.set('cursor', o.cursor);
      return call('GET', `/api/mail?${q}`);
    },
    getMail: (id) => call('GET', `/api/mail/${enc(id)}`),
    async attachment(id, partId) {
      const res = await doFetch(`${base}/api/mail/${enc(id)}/attachments/${enc(partId)}`, { headers });
      if (!res.ok) throw new ApiError(res.status, 'Pièce jointe introuvable');
      return res.blob();
    },
    file: (id, boxId) => call('POST', `/api/mail/${enc(id)}/file`, { boxId }),
    trash: (id) => call('POST', `/api/mail/${enc(id)}/trash`, {}),
    untrash: (id) => call('POST', `/api/mail/${enc(id)}/untrash`, {}),
    archive: (id) => call('POST', `/api/mail/${enc(id)}/archive`, {}),
    spam: (id) => call('POST', `/api/mail/${enc(id)}/spam`, {}),
    setTags: (id, add, remove) => call('POST', `/api/mail/${enc(id)}/tags`, { add, remove }),
    markRead: (id, read) => call('POST', `/api/mail/${enc(id)}/read`, { read }),
    batch: (ids, op) => call('POST', '/api/mail/batch', { ids, op }),
    send: (draft) => call('POST', '/api/mail/send', draft),
    sendAs: (replyTo) => call('GET', `/api/send-as${replyTo ? `?replyTo=${enc(replyTo)}` : ''}`),
    validate: (id) => call('POST', `/api/mail/${enc(id)}/validate`, {}),
    correct: (id, boxId, tagIds, opts) =>
      call('POST', `/api/mail/${enc(id)}/correct`, { boxId, tagIds, ...opts }),
    listLabels: async () => (await call<{ labels: LabelView[] }>('GET', '/api/labels')).labels,
    createLabel: (name, role) => call('POST', '/api/labels', { name, role }),
    updateLabel: (id, patch) => call('PATCH', `/api/labels/${enc(id)}`, patch),
    listRules: async () => (await call<{ rules: Rule[] }>('GET', '/api/rules')).rules,
    saveRule: ({ id, ...rule }) =>
      id === undefined ? call('POST', '/api/rules', rule) : call('PATCH', `/api/rules/${id}`, rule),
    deleteRule: async (id) => {
      await call('DELETE', `/api/rules/${id}`);
    },
    journal: (cursor) => call('GET', `/api/journal${cursor ? `?cursor=${cursor}` : ''}`),
    undo: (journalId) => call('POST', `/api/journal/${journalId}/undo`, {}),
    getSettings: () => call('GET', '/api/settings'),
    updateSettings: (patch) => call('PUT', '/api/settings', patch),
    todayStats: () => call('GET', '/api/stats/today'),
    agenda: (from, to) => items(`/api/agenda?${new URLSearchParams({ from, to })}`),
    undatedTasks: () => items('/api/tasks?undated=1'),
    allTasks: () => items('/api/tasks?all=1'),
    listCalendars: () => items('/api/calendars'),
    listTaskLists: () => items('/api/task-lists'),
    saveEvent: ({ id, calendarId, ...event }) =>
      id === undefined
        ? call('POST', `/api/events/${enc(calendarId)}`, event)
        : call('PATCH', `/api/events/${enc(calendarId)}/${enc(id)}`, event),
    deleteEvent: async (calendarId, id) => {
      await call('DELETE', `/api/events/${enc(calendarId)}/${enc(id)}`);
    },
    saveTask: ({ id, listId, ...task }) =>
      id === undefined
        ? call('POST', `/api/tasks/${enc(listId)}`, task)
        : call('PATCH', `/api/tasks/${enc(listId)}/${enc(id)}`, task),
    completeTask: (listId, id, done = true) =>
      call('POST', `/api/tasks/${enc(listId)}/${enc(id)}/complete`, { done }),
    deleteTask: async (listId, id) => {
      await call('DELETE', `/api/tasks/${enc(listId)}/${enc(id)}`);
    },
    googleStatus: () => call('GET', '/api/google/status'),
    googleAuthUrl: () => call('GET', '/api/google/auth-url'),
    googleDisconnect: async () => {
      await call('POST', '/api/google/disconnect', {});
    },
    createPairingCode: () => call('POST', '/api/pairing-codes', {}),
    listClients: async () => (await call<{ clients: LinkedClient[] }>('GET', '/api/clients')).clients,
    revokeClient: async (id) => {
      await call('DELETE', `/api/clients/${id}`);
    },
    authorize: (req) => call('POST', '/api/authorizations', req),
    getAnthropicKey: () => call('GET', '/api/anthropic-key'),
    saveAnthropicKey: (key, expires) =>
      call('PUT', '/api/anthropic-key', expires ? { key, expires } : { key }),
    health: () => call('GET', '/lun/v1/health'),
    pause: async () => {
      await call('POST', '/lun/v1/pause', {});
    },
    resume: async () => {
      await call('POST', '/lun/v1/resume', {});
    },
    subscribe(onEvent) {
      const stop = new AbortController();
      let lastId: string | undefined;
      (async () => {
        while (!stop.signal.aborted) {
          try {
            const res = await doFetch(`${base}/lun/v1/events`, {
              headers: {
                authorization: headers.authorization,
                ...(lastId ? { 'last-event-id': lastId } : {}),
              },
              signal: stop.signal,
            });
            if (!res.ok || !res.body) throw new ApiError(res.status, 'Flux d’événements indisponible');
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += value;
              let end: number;
              while ((end = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = block
                  .split('\n')
                  .filter((l) => l.startsWith('data:'))
                  .map((l) => l.slice(5).trimStart())
                  .join('\n');
                if (!data) continue;
                const event = JSON.parse(data) as LunEvent;
                lastId = event.id;
                onEvent(event);
              }
            }
          } catch {
            if (stop.signal.aborted) return;
          }
          // Reconnects after a cut, from the last event seen.
          await new Promise((r) => setTimeout(r, 3000));
        }
      })();
      return () => stop.abort();
    },
  };
}
