import type { AcediaClient, ServiceState } from '@lun-ecosystem/lunacedia-views';

/** What the shell shows around the screens: counters of the rail and state of the service. */
export interface ShellStatus {
  counts: { inbox: number; pending: number; tasks: number };
  service: ServiceState;
  /** Second line of the service card. */
  detail: string;
  /** Sorting paused by hand: the bar and the palette offer to resume, whatever the card shows. */
  paused: boolean;
}

export const EMPTY_STATUS: ShellStatus = {
  counts: { inbox: 0, pending: 0, tasks: 0 },
  service: 'actif',
  detail: '',
  paused: false,
};

/** Calendar day in Europe/Paris (global constraint), `AAAA-MM-JJ`. */
export const parisDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

const shiftDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

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
  // shortcut: overdue tasks older than 30 days are not counted; widen when the Tasks screen exists (Task 11).
  const [inbox, pending, dated, undated, health, key, settings] = await Promise.allSettled([
    client.listMail('inbox'),
    client.listMail('pending'),
    tasks ? client.agenda(parisDay(shiftDays(now, -30)), parisDay(shiftDays(now, 1))) : Promise.reject(),
    tasks ? client.undatedTasks() : Promise.reject(),
    client.health(),
    client.getAnthropicKey(),
    client.getSettings(),
  ]);
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : undefined);

  const counts = { ...last.counts };
  const inboxPage = value(inbox);
  if (inboxPage) counts.inbox = inboxPage.items.filter((m) => m.unread).length;
  const pendingPage = value(pending);
  if (pendingPage) counts.pending = pendingPage.items.length;
  const items = value(dated);
  const loose = value(undated);
  if (items && loose)
    counts.tasks = [...items, ...loose].filter(
      (t) => t.kind === 'task' && !t.done && (!t.due || t.due <= today),
    ).length;

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
