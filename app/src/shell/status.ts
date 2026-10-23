import type { AcediaClient, ServiceState } from '@lun-ecosystem/lunacedia-views';

/** What the shell shows around the screens: counters of the rail and state of the service. */
export interface ShellStatus {
  counts: { inbox: number; pending: number; tasks: number };
  service: ServiceState;
  /** Second line of the service card. */
  detail: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Reads the counters (unread mails of the inbox, proposals to validate, open tasks due by today or
 * undated) and the service state. A part that fails keeps its last value: they are hints.
 */
export async function readStatus(
  client: AcediaClient,
  last: ShellStatus,
  now = new Date(),
): Promise<ShellStatus> {
  const yearAgo = new Date(now);
  yearAgo.setFullYear(now.getFullYear() - 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const [inbox, pending, dated, undated, health, key, settings] = await Promise.allSettled([
    client.listMail('inbox'),
    client.listMail('pending'),
    client.agenda(day(yearAgo), day(tomorrow)),
    client.undatedTasks(),
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
      (t) => t.kind === 'task' && !t.done && (!t.due || t.due <= day(now)),
    ).length;

  let { service, detail } = last;
  const status = value(health)?.status;
  const keyState = value(key)?.state;
  if (keyState === 'refused' || keyState === 'credit') {
    service = 'cle-refusee';
    detail =
      keyState === 'credit' ? 'Crédit épuisé · les règles continuent' : 'Clé refusée · les règles continuent';
  } else if (status === 'paused') {
    service = 'pause';
    detail = 'Rien n’est rangé seul';
  } else if (status) {
    service = 'actif';
    const threshold = value(settings)?.threshold;
    detail = threshold === undefined ? '' : `Seuil d’auto-rangement : ${threshold} %`;
  }
  return { counts, service, detail };
}
