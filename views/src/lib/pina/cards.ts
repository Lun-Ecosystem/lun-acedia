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

/** What an id names: a mail's subject, an event's or a task's title (and its date), a rule's value. */
export interface Target {
  name: string;
  when?: string | undefined;
}

/** Names of what the input refers to: boxes and tags by id; mails, events, tasks, rules, drafts by id. */
export interface Names {
  labels: Map<string, string>;
  targets: Map<string, Target>;
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

const RULE_FIELDS: Record<string, string> = {
  from: 'Expéditeur',
  fromDomain: 'Domaine de l’expéditeur',
  to: 'Destinataire',
  subject: 'Objet',
};
const RULE_OPS: Record<string, string> = { equals: 'est exactement', contains: 'contient' };

/** Journal entries and rules both have numeric ids: an entry is named under its own key. */
const journalKey = (id: unknown) => `journal:${str(id)}`;

export function describe(card: Pick<PinaCard, 'action' | 'input'>, names: Names): CardText {
  const input = (card.input ?? {}) as Input;
  const label = (id: unknown) => names.labels.get(str(id)) ?? str(id);
  /** What a write acts on: its name when today's thread knows it, else its id, so no card is blind. */
  const named = (what: string, key = str(input.id)): CardField[] => {
    const name = names.targets.get(key)?.name;
    return [name ? { label: what, value: name } : { label: 'Identifiant', value: str(input.id) }];
  };
  const mail = () => named('Mail');
  /** A deletion says what goes: its name and date when today's thread knows them, its id always. */
  const doomed = (what: string, date = 'Date'): CardField[] => {
    const t = names.targets.get(str(input.id));
    return [
      ...(t ? [{ label: what, value: t.name }] : []),
      ...(t?.when ? [{ label: date, value: whenLabel(t.when) }] : []),
      { label: 'Identifiant', value: str(input.id) },
    ];
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
  const rule = (): CardField[] => [
    ...(input.field ? [{ label: 'Champ', value: RULE_FIELDS[str(input.field)] ?? str(input.field) }] : []),
    ...(input.op ? [{ label: 'Condition', value: RULE_OPS[str(input.op)] ?? str(input.op) }] : []),
    ...fields(input, [['Valeur', 'value']]),
    ...(input.boxId ? [{ label: 'Boîte', value: label(input.boxId) }] : []),
    ...(Array.isArray(input.tagIds) ? [{ label: 'Étiquettes', value: tags(input.tagIds) || 'aucune' }] : []),
    ...(typeof input.enabled === 'boolean'
      ? [{ label: 'Active', value: input.enabled ? 'oui' : 'non' }]
      : []),
  ];

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
        fields: [...named('Événement'), ...fields(input, event)],
        done: 'Événement modifié',
      };
    case 'event.delete':
      return {
        icon: icons.Trash,
        title: 'Supprimer un événement',
        fields: doomed('Événement'),
        done: 'Événement supprimé',
      };
    case 'task.create':
      return {
        icon: icons.List,
        title: 'Créer une tâche',
        fields: fields(input, task),
        done: `Tâche${quoted(input.title)} créée`,
      };
    case 'task.update':
      if (typeof input.done === 'boolean')
        return {
          icon: icons.Check,
          title: input.done ? 'Cocher une tâche' : 'Décocher une tâche',
          fields: [...named('Tâche'), ...fields(input, task)],
          done: input.done ? 'Tâche cochée' : 'Tâche décochée',
        };
      return {
        icon: icons.List,
        title: 'Modifier une tâche',
        fields: [...named('Tâche'), ...fields(input, task)],
        done: 'Tâche modifiée',
      };
    case 'task.complete':
      return { icon: icons.Check, title: 'Cocher une tâche', fields: named('Tâche'), done: 'Tâche cochée' };
    case 'task.delete':
      return {
        icon: icons.Trash,
        title: 'Supprimer une tâche',
        fields: doomed('Tâche', 'Échéance'),
        done: 'Tâche supprimée',
      };
    case 'draft.create':
    case 'draft.update':
      return {
        icon: icons.Reply,
        title: input.replyTo ? 'Brouillon de réponse' : 'Brouillon',
        fields: [
          ...(card.action === 'draft.update' ? named('Brouillon') : []),
          ...fields(input, [
            ['À', 'to'],
            ['Copie', 'cc'],
            ['Objet', 'subject'],
            ['Texte', 'text'],
          ]),
        ],
        done: 'Brouillon prêt, non envoyé',
      };
    case 'draft.delete':
      return {
        icon: icons.Trash,
        title: 'Jeter un brouillon',
        fields: doomed('Brouillon'),
        done: 'Brouillon jeté',
      };
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
        fields: [
          names.labels.has(str(input.id))
            ? { label: 'Libellé', value: label(input.id) }
            : { label: 'Identifiant', value: str(input.id) },
          {
            label: 'Nouveau rôle',
            value: input.role === 'box' ? 'Boîte' : input.role === 'tag' ? 'Étiquette' : 'aucun rôle',
          },
        ],
        done: 'Rôle changé',
      };
    case 'journal.undo':
      return {
        icon: icons.Undo,
        title: 'Annuler une action du journal',
        fields: named('Annule', journalKey(input.id)),
        done: 'Action annulée',
      };
    case 'rule.create':
    case 'rule.update':
      return {
        icon: icons.Funnel,
        title: card.action === 'rule.create' ? 'Créer une règle de tri' : 'Modifier une règle de tri',
        fields: [...(card.action === 'rule.update' ? named('Règle') : []), ...rule()],
        done: card.action === 'rule.create' ? 'Règle créée' : 'Règle modifiée',
      };
    case 'rule.delete':
      return {
        icon: icons.Trash,
        title: 'Supprimer une règle de tri',
        fields: doomed('Règle'),
        done: 'Règle supprimée',
      };
    default:
      // shortcut: an action without its own wording shows its name; add a case when the catalogue grows.
      return { icon: icons.Sparkles, title: card.action, fields: [], done: 'Fait' };
  }
}

/** Instant of a Google event's start (`{ dateTime }` or `{ date }`), or the plain value. */
const instant = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    return str(o.dateTime) || str(o.date) || undefined;
  }
  return undefined;
};

/**
 * What today's thread names by id: the results Pina read (`mail.read`, `agenda.list`, `task.list`,
 * `rule.list`…) and those of her done cards. Mails by subject, events and tasks by title, rules by value.
 */
export function targetsOf(thread: PinaThread | null): Map<string, Target> {
  const out = new Map<string, Target>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || typeof v !== 'object' || v === null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.subject) || str(o.title) || str(o.summary) || str(o.value);
    // A journal entry names the mail it moved; its id is not a rule's.
    const key = 'messageId' in o && 'origin' in o ? journalKey(id) : id;
    if (id && name) out.set(key, { name, when: instant(o.start) ?? (str(o.due) || undefined) });
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const { message: m } of thread?.messages ?? []) {
    if (m.role !== 'tool' || m.isError) continue;
    try {
      walk(JSON.parse(m.content), 0);
    } catch {
      // A plain text result names nothing.
    }
  }
  for (const c of thread?.cards ?? []) walk(c.result, 0);
  return out;
}
