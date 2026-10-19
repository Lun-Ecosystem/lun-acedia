import type { Address, LabelView } from '../types.ts';

/** Today: the time; otherwise the day and month (« 2 nov. »), with the year when it is not this one. */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export const longDate = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });

export const sender = (a: Address) => a.name ?? a.addr;

/** The name of a proposal's target: a box, the trash, spam, or none. */
export function targetName(boxId: string | null, labels: LabelView[]): string {
  if (boxId === 'trash') return 'Corbeille';
  if (boxId === 'spam') return 'Spam';
  if (boxId === null) return 'Aucune boîte';
  return labels.find((l) => l.id === boxId)?.name ?? boxId;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
