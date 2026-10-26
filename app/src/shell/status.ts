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
  const [inbox, pending, all, health, key, settings] = await Promise.allSettled([
    client.listMail('inbox'),
    client.listMail('pending'),
    tasks ? client.allTasks() : Promise.reject(),
    client.health(),
    client.getAnthropicKey(),
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
  const keyState = value(key)?.state;
  if (state) paused = state.status === 'paused' || state.paused === true;
  if (keyState === 'refused' || keyState === 'credit') {
    service = 'cle-refusee';
    detail = keyState === 'credit' ? DEGRADED.credit! : 'Clé refusée · les règles continuent';
  } else if (state?.status === 'degraded') {
    // Degraded wins over paused on the server: something is broken and must show.
    service = state.reason?.includes('credit') ? 'cle-refusee' : 'pause';
    detail = DEGRADED[state.reason?.split(',')[0]?.trim() ?? ''] ?? 'Service dégradé';
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
