import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createEvent, deleteEvent, mainCalendar, updateEvent } from '../agenda/calendar.ts';
import { createTask, deleteTask, mainTaskList, updateTask } from '../agenda/tasks.ts';
import { isDateOrInstant, isDay } from '../agenda/time.ts';
import { agendaRange } from '../agenda/unified.ts';
import {
  archiveMail,
  BadRequestError,
  fileMail,
  NotFoundError,
  setTags,
  trashMail,
  type ActionDeps,
} from '../gmail/actions.ts';
import { plainText } from '../gmail/body.ts';
import { readMail, searchMail, summary } from '../gmail/read.ts';
import type { GoogleClient } from '../google/client.ts';
import type { MailDetail } from '../types.ts';
import { correct, onManualFile, validate, withProposal } from '../triage/pipeline.ts';
import { stripUndefined } from '../util.ts';
import { InvalidInputError, type ActionRegistry } from './actions.ts';

const When = z.string().refine(isDateOrInstant, 'Date attendue (AAAA-MM-JJ ou ISO 8601)');
const Day = z.string().refine(isDay, 'Date attendue (AAAA-MM-JJ)');
const Id = z.string().min(1);

const EventFields = {
  title: z.string().trim().min(1),
  start: When.describe('Début : ISO 8601, ou AAAA-MM-JJ pour une journée entière'),
  end: When.describe('Fin exclue, même format que le début'),
  allDay: z.boolean(),
  location: z.string(),
  reminders: z.array(z.number().int().min(0).max(40_320)).describe('Minutes avant le début'),
};

const TaskFields = {
  title: z.string().trim().min(1),
  due: Day.nullable().describe('Échéance AAAA-MM-JJ, null pour la retirer'),
  notes: z.string(),
};

/**
 * Registers the actions the core may call. Each one runs the same functions as the front's API; an
 * action asked by the core is a requested gesture, so it runs even while paused.
 */
export function registerCatalog(
  actions: ActionRegistry,
  deps: { db: DatabaseSync; google: GoogleClient | undefined; clock: () => Date },
): void {
  const mail = (): ActionDeps => {
    if (!deps.google) throw new Error('Google n’est pas configuré sur ce serveur');
    return { db: deps.db, google: deps.google, now: deps.clock };
  };
  /** Input that passed the schema but makes no sense (not a box…) is a 400 for the core too. */
  const add = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    run: (input: T) => Promise<unknown>,
  ) =>
    actions.register(name, description, schema, async (input) => {
      try {
        return await run(input);
      } catch (err) {
        if (err instanceof BadRequestError) throw new InvalidInputError(err.message);
        throw err;
      }
    });
  const ok = { ok: true };

  add(
    'mail.search',
    'Cherche des mails (même syntaxe que la recherche Gmail) ; renvoie leurs résumés.',
    z.object({ q: z.string().min(1), max: z.number().int().min(1).max(50).optional() }),
    async ({ q, max }) => {
      const found = await searchMail(deps.db, mail().google, q);
      return { items: found.items.slice(0, max ?? 20).map((m) => summary(withProposal(deps.db, m))) };
    },
  );
  add('mail.read', 'Lit un mail : en-têtes et texte.', z.object({ id: Id }), async ({ id }) => {
    const read = await readMail(deps.db, mail().google, id, (m) => withProposal(deps.db, m));
    if (!read) throw new NotFoundError();
    // The core reads text: the rendered HTML stays for the views.
    const detail: Partial<MailDetail> = { ...read.detail };
    delete detail.html;
    return { ...detail, text: plainText(read.payload) };
  });
  add(
    'mail.file',
    'Range un mail dans une boîte (il quitte la boîte de réception).',
    z.object({ id: Id, boxId: Id }),
    async ({ id, boxId }) => {
      const change = await fileMail(mail(), id, boxId);
      onManualFile(mail(), id, boxId);
      return change;
    },
  );
  add(
    'mail.trash',
    'Met un mail à la corbeille (jamais de suppression définitive).',
    z.object({ id: Id }),
    ({ id }) => trashMail(mail(), id),
  );
  add('mail.archive', 'Archive un mail (il quitte la boîte de réception).', z.object({ id: Id }), ({ id }) =>
    archiveMail(mail(), id),
  );
  add(
    'mail.tags',
    'Ajoute ou retire des étiquettes à un mail.',
    z.object({ id: Id, add: z.array(Id).default([]), remove: z.array(Id).default([]) }),
    ({ id, add: tags, remove }) => setTags(mail(), id, tags, remove),
  );
  add('mail.validate', 'Accepte la proposition de tri d’un mail.', z.object({ id: Id }), ({ id }) =>
    validate(mail(), id),
  );
  add(
    'mail.correct',
    'Range un mail autrement que proposé (boîte, `trash` ou `spam`, et étiquettes).',
    z.object({ id: Id, boxId: Id, tagIds: z.array(Id).default([]) }),
    ({ id, boxId, tagIds }) => correct(mail(), id, boxId, tagIds),
  );

  add(
    'agenda.list',
    'Événements et tâches datées d’une période [from, to).',
    z.object({ from: When, to: When }),
    async ({ from, to }) => ({ items: agendaRange(deps.db, from, to) }),
  );
  add(
    'event.create',
    'Crée un événement (dans l’agenda principal par défaut).',
    z.object({
      calendarId: Id.optional(),
      ...EventFields,
      allDay: EventFields.allDay.default(false),
      location: EventFields.location.optional(),
      reminders: EventFields.reminders.optional(),
    }),
    async ({ calendarId, ...input }) => {
      const calendar = calendarId ?? mainCalendar(deps.db);
      if (!calendar) throw new BadRequestError('Aucun agenda synchronisé');
      return createEvent(mail(), calendar, stripUndefined(input));
    },
  );
  add(
    'event.update',
    'Modifie un événement (seuls les champs donnés changent).',
    z.object({ calendarId: Id, id: Id, ...z.object(EventFields).partial().shape }),
    ({ calendarId, id, ...patch }) => updateEvent(mail(), calendarId, id, stripUndefined(patch)),
  );
  add(
    'event.delete',
    'Supprime un événement.',
    z.object({ calendarId: Id, id: Id }),
    async ({ calendarId, id }) => {
      await deleteEvent(mail(), calendarId, id);
      return ok;
    },
  );

  add(
    'task.create',
    'Crée une tâche (dans la liste principale par défaut).',
    z.object({
      listId: Id.optional(),
      title: TaskFields.title,
      due: Day.optional().describe('Échéance AAAA-MM-JJ'),
      notes: TaskFields.notes.optional(),
    }),
    async ({ listId, ...input }) => {
      const list = listId ?? mainTaskList(deps.db);
      if (!list) throw new BadRequestError('Aucune liste de tâches synchronisée');
      return createTask(mail(), list, stripUndefined(input));
    },
  );
  add(
    'task.update',
    'Modifie une tâche (seuls les champs donnés changent).',
    z.object({ listId: Id, id: Id, ...z.object(TaskFields).partial().shape, done: z.boolean().optional() }),
    ({ listId, id, ...patch }) => updateTask(mail(), listId, id, stripUndefined(patch)),
  );
  add('task.complete', 'Coche une tâche.', z.object({ listId: Id, id: Id }), ({ listId, id }) =>
    updateTask(mail(), listId, id, { done: true }),
  );
  add('task.delete', 'Supprime une tâche.', z.object({ listId: Id, id: Id }), async ({ listId, id }) => {
    await deleteTask(mail(), listId, id);
    return ok;
  });
}
