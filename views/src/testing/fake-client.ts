import { vi } from 'vitest';
import { ApiError, type AcediaClient } from '../lib/client.ts';
import type { JournalEntry, LabelChange, LabelView, MailDetail, MailSummary } from '../lib/types.ts';

export const LABELS: LabelView[] = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'L-ecole', name: 'École', type: 'user', role: 'box' },
  { id: 'L-perso', name: 'Perso', type: 'user', role: 'box' },
  { id: 'L-urgent', name: 'Urgent', type: 'user', role: 'tag' },
];

const mail = (n: number, extra: Partial<MailSummary> = {}): MailSummary => ({
  id: `m${n}`,
  threadId: `t${n}`,
  from: { name: `Expéditeur ${n}`, addr: `exp${n}@example.com` },
  subject: `Sujet ${n}`,
  snippet: `Aperçu ${n}`,
  date: `2026-11-02T0${9 - n}:00:00.000Z`,
  unread: true,
  labels: ['INBOX', 'UNREAD'],
  ...extra,
});

/** Five mails in the inbox, the second with a pending proposal for École at 72 %. */
export function fiveMails(): MailSummary[] {
  return [
    mail(1),
    mail(2, { proposal: { boxId: 'L-ecole', tagIds: [], confidence: 72, status: 'pending' } }),
    mail(3),
    mail(4),
    mail(5),
  ];
}

/**
 * An in-memory `AcediaClient`: every method is a `vi.fn`, so tests can check the calls or make one
 * fail with `mockRejectedValueOnce`.
 */
export function fakeClient(opts: { mails?: MailSummary[]; journal?: JournalEntry[] } = {}) {
  const mails = opts.mails ?? fiveMails();
  const journal = opts.journal ?? [];

  const relabel = (id: string, add: string[], remove: string[]): LabelChange => {
    const m = mails.find((x) => x.id === id);
    if (!m) throw new ApiError(404, 'Mail introuvable');
    const before = [...m.labels];
    m.labels = [...new Set([...m.labels.filter((l) => !remove.includes(l)), ...add])];
    m.unread = m.labels.includes('UNREAD');
    return { id, before, after: [...m.labels] };
  };
  const boxes = () => LABELS.filter((l) => l.role === 'box').map((l) => l.id);
  const inView = (view: string, m: MailSummary) => {
    if (view === 'inbox') return m.labels.includes('INBOX');
    if (view === 'pending') return m.labels.includes('INBOX') && m.proposal?.status === 'pending';
    if (view.startsWith('box:')) return m.labels.includes(view.slice(4));
    return false;
  };
  const notUsed = () => Promise.reject(new Error('not used in this test'));

  const client = {
    listMail: vi.fn(async (view: string) => ({
      items: structuredClone(mails.filter((m) => inView(view, m))),
    })),
    getMail: vi.fn(async (id: string): Promise<MailDetail> => {
      const m = mails.find((x) => x.id === id);
      if (!m) throw new ApiError(404, 'Mail introuvable');
      return {
        ...structuredClone(m),
        to: 'moi@example.com',
        html: `<p>Corps de ${m.subject}</p>`,
        attachments: [],
      };
    }),
    attachment: vi.fn(async () => new Blob(['contenu'])),
    file: vi.fn(async (id: string, boxId: string) =>
      relabel(id, [boxId], ['INBOX', ...boxes().filter((b) => b !== boxId)]),
    ),
    trash: vi.fn(async (id: string) => relabel(id, ['TRASH'], ['INBOX'])),
    untrash: vi.fn(async (id: string) => relabel(id, [], ['TRASH'])),
    archive: vi.fn(async (id: string) => relabel(id, [], ['INBOX'])),
    spam: vi.fn(async (id: string) => relabel(id, ['SPAM'], ['INBOX'])),
    setTags: vi.fn(async (id: string, add: string[], remove: string[]) => relabel(id, add, remove)),
    markRead: vi.fn(async (id: string, read: boolean) =>
      read ? relabel(id, [], ['UNREAD']) : relabel(id, ['UNREAD'], []),
    ),
    batch: vi.fn(notUsed),
    send: vi.fn(async () => ({ id: 'sent1', threadId: 't-new' })),
    sendAs: vi.fn(async () => ({
      addresses: [{ email: 'moi@example.com', name: 'Moi', primary: true }],
      default: 'moi@example.com',
    })),
    validate: vi.fn(async (id: string) => {
      const m = mails.find((x) => x.id === id)!;
      relabel(id, [m.proposal!.boxId!], ['INBOX']);
      m.proposal = { ...m.proposal!, status: 'accepted' };
      return m.proposal;
    }),
    correct: vi.fn(async (id: string, boxId: string, tagIds: string[]) => {
      const m = mails.find((x) => x.id === id)!;
      relabel(id, [boxId, ...tagIds], ['INBOX']);
      m.proposal = { boxId, tagIds, confidence: m.proposal?.confidence ?? 0, status: 'corrected' };
      return m.proposal;
    }),
    listLabels: vi.fn(async () => structuredClone(LABELS)),
    createLabel: vi.fn(notUsed),
    updateLabel: vi.fn(notUsed),
    listRules: vi.fn(async () => []),
    saveRule: vi.fn(notUsed),
    deleteRule: vi.fn(notUsed),
    journal: vi.fn(async () => ({ items: structuredClone(journal) })),
    undo: vi.fn(notUsed),
    getSettings: vi.fn(async () => ({ threshold: 100 })),
    putSettings: vi.fn(async (patch: { threshold?: number }) => ({ threshold: patch.threshold ?? 100 })),
    agenda: vi.fn(async () => []),
    undatedTasks: vi.fn(async () => []),
    listCalendars: vi.fn(async () => []),
    listTaskLists: vi.fn(async () => []),
    saveEvent: vi.fn(notUsed),
    deleteEvent: vi.fn(notUsed),
    saveTask: vi.fn(notUsed),
    completeTask: vi.fn(notUsed),
    deleteTask: vi.fn(notUsed),
    googleStatus: vi.fn(async () => ({ connected: true, email: 'moi@example.com' })),
    googleAuthUrl: vi.fn(notUsed),
    googleDisconnect: vi.fn(notUsed),
    createPairingCode: vi.fn(notUsed),
    subscribe: vi.fn(() => () => {}),
  } satisfies AcediaClient;
  return { client, mails };
}
