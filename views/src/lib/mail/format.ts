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

/** « mer. 21 oct. 2026, 09:12 ». */
export const longDate = (iso: string) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${day}, ${time(iso)}`;
};

/** « 09:12 ». */
export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Heading of a day of the list: « Aujourd’hui », « Hier », « lun. 19 oct. » (with the year if not this one). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Aujourd’hui';
  if (d.toDateString() === yesterday.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** « il y a 2 h » within a day, nothing beyond. */
export function ago(iso: string, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 0 || minutes >= 24 * 60) return '';
  if (minutes < 1) return 'à l’instant';
  return minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.floor(minutes / 60)} h`;
}

/** « Free Mobile » gives FM, « Google » gives G. */
export function initials(name: string): string {
  const words = name
    .replace(/[<>"@].*$/, '')
    .split(/[\s_-]+/)
    .filter((w) => /\p{L}/u.test(w));
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? name).slice(0, 1)).toUpperCase();
}

/** A stable tone (0 to 4) for a sender or a box, from the shared tones: no color is invented. */
export function toneOf(key: string): number {
  let h = 0;
  for (const c of key.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5;
}

const BOX_COLORS = ['var(--accent-texte)', 'var(--attention)', 'var(--ok)', 'var(--ia)', 'var(--lavis)'];

/** Color of the square of a box (rail, menu). */
export const boxColor = (id: string) => BOX_COLORS[toneOf(id)]!;

/** The shared tones in a fixed order: the n-th calendar or task list takes the n-th, without clash up to five. */
export const toneColor = (index: number) => BOX_COLORS[index % BOX_COLORS.length]!;

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
