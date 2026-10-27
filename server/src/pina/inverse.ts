import type { DatabaseSync } from 'node:sqlite';
import { getEvent } from '../agenda/calendar.ts';
import { getTask } from '../agenda/tasks.ts';
import { listRules } from '../triage/rules.ts';

export interface Inverse {
  action: string;
  input: Record<string, unknown>;
}

type Fields = Record<string, unknown>;
const fields = (v: unknown): Fields => (v && typeof v === 'object' ? (v as Fields) : {});

/** The ids of an update: kept as they are in its inverse. */
const KEYS: Record<string, string[]> = {
  'event.update': ['calendarId', 'id'],
  'task.update': ['listId', 'id'],
  'rule.update': ['id'],
};

/** What an update will overwrite, read in the local cache before the write. */
export function beforeOf(db: DatabaseSync, action: string, input: unknown): unknown {
  const i = fields(input);
  if (action === 'event.update') return getEvent(db, String(i.calendarId), String(i.id));
  if (action === 'task.update') return getTask(db, String(i.listId), String(i.id));
  if (action === 'rule.update') return listRules(db).find((r) => r.id === i.id);
  return undefined;
}

/** The action that undoes a done write (its « Annuler »), or `null` when there is none. */
export function inverseOf(action: string, input: unknown, result: unknown, before: unknown): Inverse | null {
  const i = fields(input);
  const r = fields(result);
  switch (action) {
    case 'event.create':
      return { action: 'event.delete', input: { calendarId: r.calendarId, id: r.id } };
    case 'task.create':
      return { action: 'task.delete', input: { listId: r.listId, id: r.id } };
    case 'rule.create':
      return { action: 'rule.delete', input: { id: r.id } };
    case 'draft.create':
      return { action: 'draft.delete', input: { id: r.id } };
    case 'event.update':
    case 'task.update':
    case 'rule.update': {
      if (!before) return null;
      const b = fields(before);
      const keys = KEYS[action]!;
      const restored = Object.fromEntries(
        // A field absent before is cleared: no due date is `null`, no text is ''.
        Object.keys(i).map((k) => [k, keys.includes(k) ? i[k] : (b[k] ?? (k === 'due' ? null : ''))]),
      );
      return { action, input: restored };
    }
    case 'mail.file':
    case 'mail.archive':
    case 'mail.trash':
    case 'mail.untrash':
    case 'mail.spam':
    case 'mail.tags':
    case 'mail.markRead':
      if (typeof r.journalId === 'number') return { action: 'journal.undo', input: { id: r.journalId } };
      // The journal keeps neither read, tags nor untrash: their opposite gesture undoes them.
      if (action === 'mail.markRead') return { action, input: { id: i.id, read: !i.read } };
      if (action === 'mail.tags')
        return { action, input: { id: i.id, add: i.remove ?? [], remove: i.add ?? [] } };
      if (action === 'mail.untrash') return { action: 'mail.trash', input: { id: i.id } };
      return null;
    default:
      return null;
  }
}
