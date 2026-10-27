import * as icons from '../ui/Icon.ts';
import type { IconComponent } from '../ui/Icon.ts';
import type { PinaCard, PinaThread } from '../types.ts';

/*
 * What a card says of its action, in plain French, from the action name and its input: a title, the
 * readable fields (those with a `key` can be changed by « Modifier »), and the line of a done card.
 */

export interface CardField {
  label: string;
  value: string;
  /** Input key, for the fields « Modifier » opens. */
  key?: string | undefined;
}

export interface CardText {
  icon: IconComponent;
  title: string;
  fields: CardField[];
  /** Line of a done card (« Rangé dans Administratif »). */
  done: string;
}

/** Names of what the input refers to: boxes and tags by id, mails by id (their subject). */
export interface Names {
  labels: Map<string, string>;
  subjects: Map<string, string>;
}

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** `2026-11-12` → « jeu. 12 nov. » (the year when it is not this one). */
export function dayLabel(day: string, now = new Date()): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** An ISO instant → « lun. 27 oct. à 10 h » (« 10 h 30 »); a day alone → its day. */
export function whenLabel(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayLabel(value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const day = dayLabel(d.toLocaleDateString('en-CA'));
  const min = d.getMinutes();
  return `${day} à ${d.getHours()} h${min ? ` ${String(min).padStart(2, '0')}` : ''}`;
}

/** « 09:12 » */
export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const quoted = (v: unknown) => (str(v) ? ` “${str(v)}”` : '');

function fields(input: Input, spec: [label: string, key: string, kind?: 'when' | 'day'][]): CardField[] {
  return spec.flatMap(([label, key, kind]) => {
    const raw = str(input[key]);
    if (!raw) return [];
    const value = kind === 'when' ? whenLabel(raw) : kind === 'day' ? dayLabel(raw) : raw;
    return [{ label, value, key }];
  });
}

export function describe(card: Pick<PinaCard, 'action' | 'input'>, names: Names): CardText {
  const input = (card.input ?? {}) as Input;
  const label = (id: unknown) => names.labels.get(str(id)) ?? str(id);
  const mail = (): CardField[] => {
    const subject = names.subjects.get(str(input.id));
    return subject ? [{ label: 'Mail', value: subject }] : [];
  };
  const event: [string, string, ('when' | 'day')?][] = [
    ['Titre', 'title'],
    ['Début', 'start', 'when'],
    ['Fin', 'end', 'when'],
    ['Lieu', 'location'],
  ];
  const task: [string, string, ('when' | 'day')?][] = [
    ['Titre', 'title'],
    ['Échéance', 'due', 'day'],
    ['Notes', 'notes'],
  ];
  const tags = (ids: unknown) => (Array.isArray(ids) ? ids.map(label).join(', ') : '');

  switch (card.action) {
    case 'mail.file':
    case 'mail.correct':
      return {
        icon: icons.Folder,
        title: card.action === 'mail.file' ? 'Ranger un mail' : 'Corriger le tri',
        fields: [...mail(), { label: 'Boîte', value: label(input.boxId) }],
        done: `Rangé dans ${label(input.boxId)}`,
      };
    case 'mail.archive':
      return { icon: icons.Archive, title: 'Archiver un mail', fields: mail(), done: 'Mail archivé' };
    case 'mail.trash':
      return {
        icon: icons.Trash,
        title: 'Mettre un mail à la corbeille',
        fields: mail(),
        done: 'Mis à la corbeille',
      };
    case 'mail.untrash':
      return {
        icon: icons.Inbox,
        title: 'Sortir un mail de la corbeille',
        fields: mail(),
        done: 'Sorti de la corbeille',
      };
    case 'mail.spam':
      return {
        icon: icons.Ban,
        title: 'Signaler un indésirable',
        fields: mail(),
        done: 'Signalé comme indésirable',
      };
    case 'mail.validate':
      return {
        icon: icons.Check,
        title: 'Valider la proposition de tri',
        fields: mail(),
        done: 'Proposition validée',
      };
    case 'mail.markRead':
      return input.read === false
        ? { icon: icons.Mail, title: 'Marquer comme non lu', fields: mail(), done: 'Marqué comme non lu' }
        : { icon: icons.Mail, title: 'Marquer comme lu', fields: mail(), done: 'Marqué comme lu' };
    case 'mail.tags':
      return {
        icon: icons.Tag,
        title: 'Changer les étiquettes',
        fields: [
          ...mail(),
          ...(tags(input.add) ? [{ label: 'Ajouter', value: tags(input.add) }] : []),
          ...(tags(input.remove) ? [{ label: 'Retirer', value: tags(input.remove) }] : []),
        ],
        done: 'Étiquettes changées',
      };
    case 'event.create':
      return {
        icon: icons.Calendar,
        title: 'Créer un événement',
        fields: fields(input, event),
        done: `Événement${quoted(input.title)} créé`,
      };
    case 'event.update':
      return {
        icon: icons.Calendar,
        title: 'Modifier un événement',
        fields: fields(input, event),
        done: 'Événement modifié',
      };
    case 'event.delete':
      return { icon: icons.Trash, title: 'Supprimer un événement', fields: [], done: 'Événement supprimé' };
    case 'task.create':
      return {
        icon: icons.List,
        title: 'Créer une tâche',
        fields: fields(input, task),
        done: `Tâche${quoted(input.title)} créée`,
      };
    case 'task.update':
      return {
        icon: icons.List,
        title: 'Modifier une tâche',
        fields: fields(input, task),
        done: 'Tâche modifiée',
      };
    case 'task.complete':
      return { icon: icons.Check, title: 'Cocher une tâche', fields: [], done: 'Tâche cochée' };
    case 'task.delete':
      return { icon: icons.Trash, title: 'Supprimer une tâche', fields: [], done: 'Tâche supprimée' };
    case 'draft.create':
    case 'draft.update':
      return {
        icon: icons.Reply,
        title: input.replyTo ? 'Brouillon de réponse' : 'Brouillon',
        fields: fields(input, [
          ['À', 'to'],
          ['Objet', 'subject'],
          ['Texte', 'text'],
        ]),
        done: 'Brouillon prêt, non envoyé',
      };
    case 'draft.delete':
      return { icon: icons.Trash, title: 'Jeter un brouillon', fields: [], done: 'Brouillon jeté' };
    case 'label.create':
      return {
        icon: icons.Folder,
        title: input.role === 'tag' ? 'Créer une étiquette' : 'Créer une boîte',
        fields: fields(input, [['Nom', 'name']]),
        done: `${input.role === 'tag' ? 'Étiquette' : 'Boîte'}${quoted(input.name)} créée`,
      };
    case 'label.setRole':
      return {
        icon: icons.Folder,
        title: 'Changer le rôle d’un libellé',
        fields: [{ label: 'Libellé', value: label(input.id) }],
        done: 'Rôle changé',
      };
    case 'journal.undo':
      return { icon: icons.Undo, title: 'Annuler une action du journal', fields: [], done: 'Action annulée' };
    case 'rule.create':
    case 'rule.update':
      return {
        icon: icons.Funnel,
        title: card.action === 'rule.create' ? 'Créer une règle de tri' : 'Modifier une règle de tri',
        fields: [
          ...fields(input, [['Valeur', 'value']]),
          ...(input.boxId ? [{ label: 'Boîte', value: label(input.boxId) }] : []),
        ],
        done: card.action === 'rule.create' ? 'Règle créée' : 'Règle modifiée',
      };
    case 'rule.delete':
      return { icon: icons.Trash, title: 'Supprimer une règle de tri', fields: [], done: 'Règle supprimée' };
    default:
      // shortcut: an action without its own wording shows its name; add a case when the catalogue grows.
      return { icon: icons.Sparkles, title: card.action, fields: [], done: 'Fait' };
  }
}

/** Mail subjects Pina read today (`mail.read`, `mail.list`…), to name « ce mail » on the cards. */
export function subjectsOf(thread: PinaThread | null): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || typeof v !== 'object' || v === null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && typeof o.subject === 'string') out.set(o.id, o.subject);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const { message: m } of thread?.messages ?? []) {
    if (m.role !== 'tool' || m.isError) continue;
    try {
      walk(JSON.parse(m.content), 0);
    } catch {
      // A plain text result names no mail.
    }
  }
  return out;
}
