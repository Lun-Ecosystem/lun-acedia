import { vi } from 'vitest';
import { ApiError, type AcediaClient } from '../lib/client.ts';
import type {
  JournalEntry,
  JournaledChange,
  LabelChange,
  LabelView,
  MailDetail,
  MailSummary,
  ModelOffer,
  ProviderView,
} from '../lib/types.ts';

export const LABELS: LabelView[] = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'L-ecole', name: 'École', type: 'user', role: 'box' },
  { id: 'L-perso', name: 'Perso', type: 'user', role: 'box' },
  { id: 'L-urgent', name: 'Urgent', type: 'user', role: 'tag' },
];

/** Anthropic in service (saved, with an expiry), OpenAI from `.env`, the others without a key. */
export const PROVIDERS: ProviderView[] = [
  { id: 'anthropic', label: 'Anthropic', state: 'ok', last4: '7f3a', expires: '2026-12-31', source: 'saved' },
  { id: 'openai', label: 'OpenAI', state: 'ok', last4: '9876', source: 'env' },
  { id: 'google', label: 'Google Gemini', state: 'absent' },
  { id: 'mistral', label: 'Mistral', state: 'absent' },
  { id: 'custom', label: 'Point d’accès compatible', state: 'absent' },
];

export const MODELS: ModelOffer[] = [
  {
    provider: 'anthropic',
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    tools: true,
    price: { input: 0.1, output: 0.5 },
    tier: '€',
  },
  {
    provider: 'openai',
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    tools: true,
    price: { input: 10, output: 50 },
    tier: '€€€',
  },
  { provider: 'openai', id: 'gpt-maison', label: 'GPT maison', tools: true, tier: null },
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
  let nextJournalId = 1;
  const journaled = (change: LabelChange): JournaledChange => ({ ...change, journalId: nextJournalId++ });
  const boxes = () => LABELS.filter((l) => l.role === 'box').map((l) => l.id);
  const inView = (view: string, m: MailSummary) => {
    if (view === 'inbox') return m.labels.includes('INBOX');
    if (view === 'pending') return m.labels.includes('INBOX') && m.proposal?.status === 'pending';
    if (view.startsWith('box:')) return m.labels.includes(view.slice(4));
    return false;
  };
  const notUsed = () => Promise.reject(new Error('not used in this test'));

  const client = {
    listMail: vi.fn<AcediaClient['listMail']>(async (view: string) => ({
      items: structuredClone(mails.filter((m) => inView(view, m))),
    })),
    getMail: vi.fn<AcediaClient['getMail']>(async (id: string): Promise<MailDetail> => {
      const m = mails.find((x) => x.id === id);
      if (!m) throw new ApiError(404, 'Mail introuvable');
      return {
        ...structuredClone(m),
        to: 'moi@example.com',
        html: `<p>Corps de ${m.subject}</p>`,
        attachments: [],
      };
    }),
    attachment: vi.fn<AcediaClient['attachment']>(async () => new Blob(['contenu'])),
    file: vi.fn<AcediaClient['file']>(async (id: string, boxId: string) =>
      journaled(relabel(id, [boxId], ['INBOX', ...boxes().filter((b) => b !== boxId)])),
    ),
    trash: vi.fn<AcediaClient['trash']>(async (id: string) => journaled(relabel(id, ['TRASH'], ['INBOX']))),
    untrash: vi.fn<AcediaClient['untrash']>(async (id: string) => relabel(id, [], ['TRASH'])),
    archive: vi.fn<AcediaClient['archive']>(async (id: string) => journaled(relabel(id, [], ['INBOX']))),
    spam: vi.fn<AcediaClient['spam']>(async (id: string) => journaled(relabel(id, ['SPAM'], ['INBOX']))),
    setTags: vi.fn<AcediaClient['setTags']>(async (id: string, add: string[], remove: string[]) =>
      relabel(id, add, remove),
    ),
    markRead: vi.fn<AcediaClient['markRead']>(async (id: string, read: boolean) =>
      read ? relabel(id, [], ['UNREAD']) : relabel(id, ['UNREAD'], []),
    ),
    batch: vi.fn<AcediaClient['batch']>(notUsed),
    send: vi.fn<AcediaClient['send']>(async () => ({ id: 'sent1', threadId: 't-new' })),
    createDraft: vi.fn<AcediaClient['createDraft']>(notUsed),
    getDraft: vi.fn<AcediaClient['getDraft']>(notUsed),
    updateDraft: vi.fn<AcediaClient['updateDraft']>(notUsed),
    deleteDraft: vi.fn<AcediaClient['deleteDraft']>(notUsed),
    sendDraft: vi.fn<AcediaClient['sendDraft']>(notUsed),
    sendAs: vi.fn<AcediaClient['sendAs']>(async () => ({
      addresses: [{ email: 'moi@example.com', name: 'Moi', primary: true }],
      default: 'moi@example.com',
    })),
    validate: vi.fn<AcediaClient['validate']>(async (id: string) => {
      const m = mails.find((x) => x.id === id)!;
      relabel(id, [m.proposal!.boxId!], ['INBOX']);
      m.proposal = { ...m.proposal!, status: 'accepted' };
      return { ...m.proposal, journalId: nextJournalId++ };
    }),
    correct: vi.fn<AcediaClient['correct']>(async (id: string, boxId: string, tagIds: string[]) => {
      const m = mails.find((x) => x.id === id)!;
      relabel(id, [boxId, ...tagIds], ['INBOX']);
      m.proposal = { boxId, tagIds, confidence: m.proposal?.confidence ?? 0, status: 'corrected' };
      return { ...m.proposal, journalId: nextJournalId++ };
    }),
    listLabels: vi.fn<AcediaClient['listLabels']>(async () => structuredClone(LABELS)),
    createLabel: vi.fn<AcediaClient['createLabel']>(notUsed),
    updateLabel: vi.fn<AcediaClient['updateLabel']>(notUsed),
    listRules: vi.fn<AcediaClient['listRules']>(async () => []),
    saveRule: vi.fn<AcediaClient['saveRule']>(notUsed),
    deleteRule: vi.fn<AcediaClient['deleteRule']>(notUsed),
    journal: vi.fn<AcediaClient['journal']>(async () => ({ items: structuredClone(journal) })),
    undo: vi.fn<AcediaClient['undo']>(notUsed),
    todayStats: vi.fn<AcediaClient['todayStats']>(async () => ({ autoFiled: 0, validated: 0, corrected: 0 })),
    getSettings: vi.fn<AcediaClient['getSettings']>(async () => ({ threshold: 100, bulkThreshold: 85 })),
    updateSettings: vi.fn<AcediaClient['updateSettings']>(async (patch) => ({
      threshold: patch.threshold ?? 100,
      bulkThreshold: patch.bulkThreshold ?? 85,
    })),
    agenda: vi.fn<AcediaClient['agenda']>(async () => []),
    undatedTasks: vi.fn<AcediaClient['undatedTasks']>(async () => []),
    allTasks: vi.fn<AcediaClient['allTasks']>(async () => []),
    listCalendars: vi.fn<AcediaClient['listCalendars']>(async () => []),
    listTaskLists: vi.fn<AcediaClient['listTaskLists']>(async () => []),
    saveEvent: vi.fn<AcediaClient['saveEvent']>(notUsed),
    deleteEvent: vi.fn<AcediaClient['deleteEvent']>(notUsed),
    saveTask: vi.fn<AcediaClient['saveTask']>(notUsed),
    completeTask: vi.fn<AcediaClient['completeTask']>(notUsed),
    deleteTask: vi.fn<AcediaClient['deleteTask']>(notUsed),
    googleStatus: vi.fn<AcediaClient['googleStatus']>(async () => ({
      connected: true,
      email: 'moi@example.com',
    })),
    googleAuthUrl: vi.fn<AcediaClient['googleAuthUrl']>(notUsed),
    googleDisconnect: vi.fn<AcediaClient['googleDisconnect']>(notUsed),
    createPairingCode: vi.fn<AcediaClient['createPairingCode']>(notUsed),
    listClients: vi.fn<AcediaClient['listClients']>(async () => [
      {
        id: 1,
        name: "Lun'Acedia (app)",
        kind: 'device',
        createdAt: '2026-10-19T08:00:00.000Z',
        current: true,
      },
      { id: 2, name: 'Assistant local', kind: 'app', createdAt: '2026-10-20T09:30:00.000Z', current: false },
    ]),
    revokeClient: vi.fn<AcediaClient['revokeClient']>(async () => {}),
    authorize: vi.fn<AcediaClient['authorize']>(notUsed),
    getProviders: vi.fn<AcediaClient['getProviders']>(async () => PROVIDERS.map((p) => ({ ...p }))),
    saveProviderKey: vi.fn<AcediaClient['saveProviderKey']>(notUsed),
    removeProviderKey: vi.fn<AcediaClient['removeProviderKey']>(async (id) => {
      const { label } = PROVIDERS.find((p) => p.id === id)!;
      return { id, label, state: 'absent' as const };
    }),
    getModels: vi.fn<AcediaClient['getModels']>(async () => MODELS.map((m) => ({ ...m }))),
    getModelChoice: vi.fn<AcediaClient['getModelChoice']>(async () => ({
      triage: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      pina: { provider: 'anthropic', model: 'claude-haiku-5-5' },
    })),
    setModelChoice: vi.fn<AcediaClient['setModelChoice']>(async (_use, provider, model) => ({
      provider,
      model,
    })),
    health: vi.fn<AcediaClient['health']>(async () => ({ status: 'ok' as const })),
    pause: vi.fn<AcediaClient['pause']>(async () => {}),
    resume: vi.fn<AcediaClient['resume']>(async () => {}),
    pinaToday: vi.fn<AcediaClient['pinaToday']>(async () => ({
      day: '2026-11-02',
      messages: [],
      cards: [],
      pending: 0,
    })),
    pinaDays: vi.fn<AcediaClient['pinaDays']>(async () => []),
    pinaDay: vi.fn<AcediaClient['pinaDay']>(notUsed),
    pinaAsk: vi.fn<AcediaClient['pinaAsk']>(notUsed),
    pinaDecide: vi.fn<AcediaClient['pinaDecide']>(notUsed),
    pinaUndo: vi.fn<AcediaClient['pinaUndo']>(notUsed),
    getPinaSettings: vi.fn<AcediaClient['getPinaSettings']>(async () => ({
      mode: 'validate' as const,
      instructions: '',
      retentionDays: 30,
      dailyCapUsd: 1,
    })),
    subscribe: vi.fn<AcediaClient['subscribe']>(() => () => {}),
  } satisfies AcediaClient;
  return { client, mails };
}
