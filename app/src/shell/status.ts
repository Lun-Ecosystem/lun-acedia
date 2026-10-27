import type { AcediaClient, ServiceState } from '@lun-ecosystem/lunacedia-views';

/** What the shell shows around the screens: counters of the rail and state of the service. */
export interface ShellStatus {
  /** `12+` when the count covers only the first page of the list. */
  counts: { inbox: Count; pending: Count; tasks: Count };
  service: ServiceState;
  /** Second line of the service card. */
  detail: string;
  /** Sorting paused by hand: the bar and the palette offer to resume, whatever the card shows. */
  paused: boolean;
}

export type Count = number | string;

export const EMPTY_STATUS: ShellStatus = {
  counts: { inbox: 0, pending: 0, tasks: 0 },
  service: 'actif',
  detail: '',
  paused: false,
};

/** Calendar day in Europe/Paris (global constraint), `AAAA-MM-JJ`. */
export const parisDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

/** Why the server is degraded, said plainly. */
const DEGRADED: Record<string, string> = {
  credit: 'Crédit épuisé · les règles continuent',
  'google-reauth': 'Compte Google à reconnecter',
};

/**
 * Reads the counters (unread mails of the inbox, proposals to validate, and with `tasks` the open tasks
 * due by today or undated) and the service state. A part that fails keeps its last value: they are hints.
 */
export async function readStatus(
  client: AcediaClient,
  last: ShellStatus,
  { tasks = true, now = new Date() }: { tasks?: boolean; now?: Date } = {},
): Promise<ShellStatus> {
  const today = parisDay(now);
  const [inbox, pending, all, health, keys, settings] = await Promise.allSettled([
    client.listMail('inbox'),
    client.listMail('pending'),
    tasks ? client.allTasks() : Promise.reject(),
    client.health(),
    client.getProviders(),
    client.getSettings(),
  ]);
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : undefined);

  // One page only (50 mails): past it, the count says it is a lower bound.
  const paged = (n: number, cursor?: string): Count => (cursor && n > 0 ? `${n}+` : n);
  const counts = { ...last.counts };
  const inboxPage = value(inbox);
  if (inboxPage) counts.inbox = paged(inboxPage.items.filter((m) => m.unread).length, inboxPage.cursor);
  const pendingPage = value(pending);
  if (pendingPage) counts.pending = paged(pendingPage.items.length, pendingPage.cursor);
  const list = value(all);
  if (list) counts.tasks = list.filter((t) => !t.done && (!t.due || t.due <= today)).length;

  let { service, detail, paused } = last;
  const state = value(health);
  const providers = value(keys);
  const problem = providers?.find((p) => p.state === 'refused' || p.state === 'credit');
  /** « Clé OpenAI refusée », or without the name when the keys could not be read. */
  const refused = (id: string) => {
    const label = providers?.find((p) => p.id === id)?.label;
    return `Clé ${label ? `${label} ` : ''}refusée · les règles continuent`;
  };
  const reasons = state?.reason?.split(',').map((r) => r.trim()) ?? [];
  // `<provider>-key`: that provider refused its key (server keyReason).
  const keyReason = reasons.find((r) => r.endsWith('-key'));
  if (state) paused = state.status === 'paused' || state.paused === true;
  if (problem) {
    service = 'cle-refusee';
    detail = problem.state === 'credit' ? DEGRADED.credit! : refused(problem.id);
  } else if (state?.status === 'degraded') {
    // Degraded wins over paused on the server: something is broken and must show.
    service = keyReason || reasons.includes('credit') ? 'cle-refusee' : 'pause';
    detail = keyReason
      ? refused(keyReason.slice(0, -'-key'.length))
      : (DEGRADED[reasons[0] ?? ''] ?? 'Service dégradé');
  } else if (state?.status === 'paused') {
    service = 'pause';
    detail = 'Rien n’est rangé seul';
  } else if (state) {
    service = 'actif';
    const threshold = value(settings)?.threshold;
    detail = threshold === undefined ? '' : `Seuil d’auto-rangement : ${threshold} %`;
  }
  return { counts, service, detail, paused };
}
