import type { RecordedCall } from './fake-fetch.ts';

export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function b64url(data: string | Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

export interface Part {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: Part[];
}

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  payload: Part;
}

/** A leaf part; `charset` is written in its Content-Type header. */
export function textPart(mimeType: string, content: string | Uint8Array, charset = 'UTF-8'): Part {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    mimeType,
    headers: [{ name: 'Content-Type', value: `${mimeType}; charset="${charset}"` }],
    body: { size: bytes.length, data: b64url(bytes) },
  };
}

export function multipart(mimeType: string, parts: Part[]): Part {
  return { mimeType, headers: [{ name: 'Content-Type', value: mimeType }], body: { size: 0 }, parts };
}

/** Numbers the parts the way Gmail does: '' for the root, then '0', '1', '0.1'… */
function numberParts(part: Part, id: string): Part {
  const numbered: Part = { ...part, partId: id };
  if (part.parts) numbered.parts = part.parts.map((p, i) => numberParts(p, id ? `${id}.${i}` : String(i)));
  return numbered;
}

/** Builds a message; headers From/To/Subject/Date come first in the payload. */
export function message(opts: {
  id: string;
  labelIds?: string[];
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  payload?: Part;
}): FakeMessage {
  const date = opts.date ?? '2026-11-01T10:00:00.000Z';
  const body = opts.payload ?? textPart('text/plain', 'Bonjour');
  const headers = [
    { name: 'From', value: opts.from ?? 'Prof Martin <prof@ecole.fr>' },
    { name: 'To', value: opts.to ?? 'moi@example.com' },
    { name: 'Subject', value: opts.subject ?? `Sujet ${opts.id}` },
    { name: 'Date', value: new Date(date).toUTCString() },
  ];
  return {
    id: opts.id,
    threadId: `t-${opts.id}`,
    labelIds: opts.labelIds ?? ['INBOX', 'UNREAD'],
    snippet: opts.snippet ?? `Aperçu ${opts.id}`,
    internalDate: String(new Date(date).getTime()),
    payload: numberParts({ ...body, headers: [...headers, ...(body.headers ?? [])] }, ''),
  };
}

type HistoryEntry = {
  id: number;
  messagesAdded?: { message: { id: string; threadId: string; labelIds: string[] } }[];
  messagesDeleted?: { message: { id: string; threadId: string } }[];
  labelsAdded?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }[];
};

const IN_LABELS: Record<string, string> = { drafts: 'DRAFT' };

const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT'];

/** An in-memory Gmail answering the REST endpoints Acedia uses, with a real history. */
export class FakeGmail {
  readonly messages = new Map<string, FakeMessage>();
  readonly attachments = new Map<string, string>();
  labels: { id: string; name: string; type: 'system' | 'user' }[] = SYSTEM_LABELS.map((id) => ({
    id,
    name: id,
    type: 'system',
  }));
  historyId = 1000;
  private minHistoryId = 1000;
  private history: HistoryEntry[] = [];
  readonly email = 'test@example.com';
  sendAs = [
    { sendAsEmail: 'test@example.com', displayName: 'Test', isPrimary: true },
    { sendAsEmail: 'contact@lun.example', displayName: "Lun'Ecosystem", isPrimary: false },
  ];
  readonly sent: { raw: string; threadId?: string }[] = [];
  /** Drafts by id: the raw message as posted. */
  readonly drafts = new Map<string, { raw: string; threadId?: string }>();
  private draftSeq = 0;

  constructor(initial: FakeMessage[] = []) {
    for (const m of initial) this.messages.set(m.id, structuredClone(m));
  }

  private record(entry: Omit<HistoryEntry, 'id'>): void {
    this.historyId += 1;
    this.history.push({ id: this.historyId, ...entry });
  }

  private ref(m: FakeMessage) {
    return { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] };
  }

  /** A new mail arrives (history: messageAdded). */
  deliver(m: FakeMessage): void {
    this.messages.set(m.id, structuredClone(m));
    this.record({ messagesAdded: [{ message: this.ref(m) }] });
  }

  /** Labels change on Google's side (history: labelAdded / labelRemoved). */
  relabel(id: string, add: string[], remove: string[]): void {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no message ${id}`);
    m.labelIds = [...new Set([...m.labelIds.filter((l) => !remove.includes(l)), ...add])];
    if (add.length) this.record({ labelsAdded: [{ message: this.ref(m), labelIds: add }] });
    if (remove.length) this.record({ labelsRemoved: [{ message: this.ref(m), labelIds: remove }] });
  }

  /** Permanently deleted on Google's side (history: messageDeleted). */
  purge(id: string): void {
    const m = this.messages.get(id);
    this.messages.delete(id);
    if (m) this.record({ messagesDeleted: [{ message: { id: m.id, threadId: m.threadId } }] });
  }

  /** Gmail forgot the history before now: an old startHistoryId answers 404. */
  expireHistory(): void {
    this.minHistoryId = this.historyId;
    this.history = [];
  }

  addLabel(name: string): string {
    const id = `Label_${this.labels.length + 1}`;
    this.labels.push({ id, name, type: 'user' });
    return id;
  }

  private sorted(filter: (m: FakeMessage) => boolean): FakeMessage[] {
    return [...this.messages.values()]
      .filter(filter)
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate) || b.id.localeCompare(a.id));
  }

  private metadata(m: FakeMessage) {
    return { ...structuredClone(m), payload: { ...m.payload, parts: undefined, body: { size: 0 } } };
  }

  /** `users.drafts`: create, get (full), update, delete, send. */
  private handleDrafts(call: RecordedCall, path: string) {
    if (path !== '/drafts' && !path.startsWith('/drafts/')) return undefined;
    const body = JSON.parse(call.body ?? '{}') as {
      id?: string;
      message?: { raw: string; threadId?: string };
    };
    const id = path.split('/')[2];
    if (call.method === 'POST' && !id) {
      const key = `d${(this.draftSeq += 1)}`;
      this.drafts.set(key, body.message!);
      return {
        json: { id: key, message: { id: `${key}-m`, threadId: body.message!.threadId ?? `${key}-t` } },
      };
    }
    if (call.method === 'POST' && id === 'send') {
      const draft = this.drafts.get(body.id ?? '');
      if (!draft) return { status: 404, json: { error: { message: 'Not Found' } } };
      this.drafts.delete(body.id!);
      this.sent.push(draft);
      return {
        json: { id: `sent-${this.sent.length}`, threadId: draft.threadId ?? 'new', labelIds: ['SENT'] },
      };
    }
    const draft = id ? this.drafts.get(id) : undefined;
    if (!draft) return { status: 404, json: { error: { message: 'Not Found' } } };
    if (call.method === 'PUT') {
      this.drafts.set(id!, body.message!);
      return { json: { id, message: { id: `${id}-m`, threadId: body.message!.threadId ?? `${id}-t` } } };
    }
    if (call.method === 'DELETE') {
      this.drafts.delete(id!);
      return { json: {} };
    }
    // GET: the raw message parsed back into headers and a text/plain part, decoded like Gmail does.
    const raw = Buffer.from(draft.raw, 'base64url').toString('utf8');
    const [head = '', ...rest] = raw.split('\r\n\r\n');
    const headers = head.split('\r\n').map((line) => {
      const [name = '', ...value] = line.split(': ');
      const v = value
        .join(': ')
        .replace(/=\?UTF-8\?B\?(.+?)\?=/g, (_, b: string) => Buffer.from(b, 'base64').toString('utf8'));
      return { name, value: v };
    });
    const b64 = rest[1]?.split('\r\n--')[0] ?? '';
    const text = Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString('utf8');
    return {
      json: {
        id: id,
        message: {
          id: `${id}-m`,
          threadId: draft.threadId ?? `${id}-t`,
          payload: {
            mimeType: 'multipart/alternative',
            headers,
            body: { size: 0 },
            parts: [textPart('text/plain', text)],
          },
        },
      },
    };
  }

  /** The fetch handler: plug it into `fakeFetch(gmail.handler)`. */
  handler = (call: RecordedCall) => {
    if (!call.url.startsWith(GMAIL)) return undefined;
    const url = new URL(call.url);
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    const q = url.searchParams;

    if (call.method === 'GET' && path === '/profile') {
      return { json: { emailAddress: this.email, historyId: String(this.historyId) } };
    }
    if (call.method === 'GET' && path === '/labels') return { json: { labels: this.labels } };

    if (call.method === 'GET' && path === '/messages') {
      // The subset of Gmail's search Acedia uses: `in:` (OR-ed), `-in:`, `before:<epoch s>`, words.
      const anyOf: string[] = [];
      const noneOf: string[] = [];
      const words: string[] = [];
      let before: number | undefined;
      for (const token of (q.get('q') ?? '').split(/\s+/).filter((t) => t && t !== 'OR')) {
        const inLabel = token.match(/^(-?)in:(\w+)$/);
        const date = token.match(/^before:(\d+)$/);
        if (inLabel) (inLabel[1] ? noneOf : anyOf).push(IN_LABELS[inLabel[2]!] ?? inLabel[2]!.toUpperCase());
        else if (date) before = Number(date[1]) * 1000;
        else words.push(token.toLowerCase());
      }
      const labelId = q.get('labelIds');
      const term = words.join(' ');
      // Like Gmail, spam and trash only show up when asked for.
      const wantsSpamTrash = [...anyOf, labelId].some((l) => l === 'SPAM' || l === 'TRASH');
      const list = this.sorted((m) => {
        const isSpamTrash = m.labelIds.includes('SPAM') || m.labelIds.includes('TRASH');
        if (isSpamTrash && !wantsSpamTrash) return false;
        if (anyOf.length && !anyOf.some((l) => m.labelIds.includes(l))) return false;
        if (labelId && !m.labelIds.includes(labelId)) return false;
        if (noneOf.some((l) => m.labelIds.includes(l))) return false;
        if (before !== undefined && Number(m.internalDate) >= before) return false;
        if (!term) return true;
        const headers = m.payload.headers?.map((h) => h.value.toLowerCase()).join(' ') ?? '';
        return headers.includes(term) || m.snippet.toLowerCase().includes(term);
      });
      const offset = Number(q.get('pageToken') ?? 0);
      const max = Number(q.get('maxResults') ?? 100);
      const page = list.slice(offset, offset + max);
      const json: Record<string, unknown> = {
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        resultSizeEstimate: list.length,
      };
      if (offset + max < list.length) json.nextPageToken = String(offset + max);
      return { json };
    }

    const att = path.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/);
    if (call.method === 'GET' && att) {
      const data = this.attachments.get(att[2]!);
      return data
        ? { json: { data, size: Buffer.from(data, 'base64url').length } }
        : { status: 404, json: {} };
    }

    const one = path.match(/^\/messages\/([^/]+)$/);
    if (call.method === 'GET' && one) {
      const m = this.messages.get(one[1]!);
      if (!m) return { status: 404, json: { error: { message: 'Not Found' } } };
      return { json: q.get('format') === 'full' ? structuredClone(m) : this.metadata(m) };
    }

    const action = path.match(/^\/messages\/([^/]+)\/(modify|trash|untrash)$/);
    if (call.method === 'POST' && action) {
      const m = this.messages.get(action[1]!);
      if (!m) return { status: 404, json: { error: { message: 'Not Found' } } };
      const body = JSON.parse(call.body ?? '{}') as { addLabelIds?: string[]; removeLabelIds?: string[] };
      const op = action[2];
      const add = op === 'trash' ? ['TRASH'] : op === 'modify' ? (body.addLabelIds ?? []) : [];
      const remove = op === 'untrash' ? ['TRASH'] : op === 'modify' ? (body.removeLabelIds ?? []) : [];
      this.relabel(m.id, add, remove);
      return { json: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } };
    }
    if (call.method === 'GET' && path === '/settings/sendAs') return { json: { sendAs: this.sendAs } };
    if (call.method === 'POST' && path === '/messages/send') {
      const body = JSON.parse(call.body ?? '{}') as { raw: string; threadId?: string };
      this.sent.push(body);
      return {
        json: { id: `sent-${this.sent.length}`, threadId: body.threadId ?? 'new', labelIds: ['SENT'] },
      };
    }
    const drafts = this.handleDrafts(call, path);
    if (drafts) return drafts;
    if (call.method === 'POST' && path === '/labels') {
      const body = JSON.parse(call.body ?? '{}') as { name: string };
      if (this.labels.some((l) => l.name.toLowerCase() === body.name.toLowerCase())) {
        return { status: 409, json: { error: { message: 'Label name exists or conflicts' } } };
      }
      const id = this.addLabel(body.name);
      return { json: { id, name: body.name, type: 'user' } };
    }

    if (call.method === 'GET' && path === '/history') {
      const start = Number(q.get('startHistoryId'));
      if (start < this.minHistoryId)
        return { status: 404, json: { error: { message: 'historyId expired' } } };
      return {
        json: { history: this.history.filter((h) => h.id > start), historyId: String(this.historyId) },
      };
    }
    return undefined;
  };
}
