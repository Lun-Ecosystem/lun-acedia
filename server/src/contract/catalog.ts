import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createEvent, deleteEvent, listCalendars, mainCalendar, updateEvent } from '../agenda/calendar.ts';
import {
  allTasks,
  createTask,
  deleteTask,
  listTaskLists,
  mainTaskList,
  updateTask,
} from '../agenda/tasks.ts';
import { isDateOrInstant, isDay } from '../agenda/time.ts';
import { agendaRange } from '../agenda/unified.ts';
import { applyOp, BadRequestError, NotFoundError, type ActionDeps, type BatchOp } from '../gmail/actions.ts';
import { plainText } from '../gmail/body.ts';
import { defaultFrom, headerValue, textToHtml } from '../gmail/compose.ts';
import { createDraft, deleteDraft, getDraft, updateDraft } from '../gmail/drafts.ts';
import { fetchFull, listMail, readMail, searchMail, summary } from '../gmail/read.ts';
import type { GoogleClient } from '../google/client.ts';
import { header, upsertMessage, viewFilter } from '../gmail/store.ts';
import type { MailDetail } from '../types.ts';
import { listJournal, todayStats, undo } from '../triage/journal.ts';
import { createLabel, listLabels, setRole } from '../triage/labels.ts';
import { afterUserAction, correct, validate, withProposal } from '../triage/pipeline.ts';
import { createRule, deleteRule, listRules, updateRule } from '../triage/rules.ts';
import { RoleSchema, RuleSchema } from '../triage/routes.ts';
import { cardText } from '../pina/lines.ts';
import { expireCards } from '../pina/agent.ts';
import { dayOf, getCard } from '../pina/store.ts';
import { stripUndefined } from '../util.ts';
import { InvalidInputError, type ActionRegistry, type Effect } from './actions.ts';

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
    effect: Effect,
    name: string,
    description: string,
    schema: z.ZodType<T>,
    run: (input: T) => Promise<unknown>,
  ) =>
    actions.register(
      name,
      description,
      schema,
      async (input) => {
        try {
          return await run(input);
        } catch (err) {
          if (err instanceof BadRequestError) throw new InvalidInputError(err.message);
          throw err;
        }
      },
      effect,
    );
  const ok = { ok: true };
  /** A mail gesture through the same path as the screen's: learned and journaled, so undoable. */
  const journaled = async (id: string, op: BatchOp) => {
    const change = await applyOp(mail(), id, op);
    const journalId = afterUserAction(mail(), change, op);
    return journalId === undefined ? change : { ...change, journalId };
  };

  add(
    'read',
    'mail.search',
    'Cherche des mails (même syntaxe que la recherche Gmail) ; renvoie leurs résumés.',
    z.object({ q: z.string().min(1), max: z.number().int().min(1).max(50).optional() }),
    async ({ q, max }) => {
      const found = await searchMail(deps.db, mail().google, q);
      return { items: found.items.slice(0, max ?? 20).map((m) => summary(withProposal(deps.db, m))) };
    },
  );
  add('read', 'mail.read', 'Lit un mail : en-têtes et texte.', z.object({ id: Id }), async ({ id }) => {
    const read = await readMail(deps.db, mail().google, id, (m) => withProposal(deps.db, m));
    if (!read) throw new NotFoundError();
    // The core reads text: the rendered HTML stays for the views.
    const detail: Partial<MailDetail> = { ...read.detail };
    delete detail.html;
    return { ...detail, text: plainText(read.payload) };
  });
  add(
    'write',
    'mail.file',
    'Range un mail dans une boîte (il quitte la boîte de réception).',
    z.object({ id: Id, boxId: Id }),
    ({ id, boxId }) => journaled(id, { kind: 'file', boxId }),
  );
  add(
    'write',
    'mail.trash',
    'Met un mail à la corbeille (jamais de suppression définitive).',
    z.object({ id: Id }),
    ({ id }) => journaled(id, { kind: 'trash' }),
  );
  add(
    'write',
    'mail.archive',
    'Archive un mail (il quitte la boîte de réception).',
    z.object({ id: Id }),
    ({ id }) => journaled(id, { kind: 'archive' }),
  );
  add(
    'write',
    'mail.tags',
    'Ajoute ou retire des étiquettes à un mail.',
    z.object({ id: Id, add: z.array(Id).default([]), remove: z.array(Id).default([]) }),
    ({ id, add: tags, remove }) => journaled(id, { kind: 'tags', add: tags, remove }),
  );
  add('write', 'mail.validate', 'Accepte la proposition de tri d’un mail.', z.object({ id: Id }), ({ id }) =>
    validate(mail(), id),
  );
  add(
    'write',
    'mail.correct',
    'Range un mail autrement que proposé (boîte, `trash` ou `spam`, et étiquettes).',
    z.object({ id: Id, boxId: Id, tagIds: z.array(Id).default([]) }),
    ({ id, boxId, tagIds }) => correct(mail(), id, boxId, tagIds),
  );

  add(
    'read',
    'agenda.list',
    'Événements et tâches datées d’une période [from, to).',
    z.object({ from: When, to: When }),
    async ({ from, to }) => ({ items: agendaRange(deps.db, from, to) }),
  );
  add(
    'write',
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
    'write',
    'event.update',
    'Modifie un événement (seuls les champs donnés changent).',
    z.object({ calendarId: Id, id: Id, ...z.object(EventFields).partial().shape }),
    ({ calendarId, id, ...patch }) => updateEvent(mail(), calendarId, id, stripUndefined(patch)),
  );
  add(
    'delete',
    'event.delete',
    'Supprime un événement.',
    z.object({ calendarId: Id, id: Id }),
    async ({ calendarId, id }) => {
      await deleteEvent(mail(), calendarId, id);
      return ok;
    },
  );

  add(
    'write',
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
    'write',
    'task.update',
    'Modifie une tâche (seuls les champs donnés changent).',
    z.object({ listId: Id, id: Id, ...z.object(TaskFields).partial().shape, done: z.boolean().optional() }),
    ({ listId, id, ...patch }) => updateTask(mail(), listId, id, stripUndefined(patch)),
  );
  add('write', 'task.complete', 'Coche une tâche.', z.object({ listId: Id, id: Id }), ({ listId, id }) =>
    updateTask(mail(), listId, id, { done: true }),
  );
  add(
    'delete',
    'task.delete',
    'Supprime une tâche.',
    z.object({ listId: Id, id: Id }),
    async ({ listId, id }) => {
      await deleteTask(mail(), listId, id);
      return ok;
    },
  );

  add(
    'read',
    'mail.list',
    'Liste une page d’une vue (inbox, pending, trash, spam, sent) ou d’une boîte (son id), du plus récent au plus ancien.',
    z.object({ view: Id, cursor: z.string().optional() }),
    async ({ view, cursor }) => {
      // A bare box id is what label.list gives; the screen's own view name is `box:<id>`.
      const named = viewFilter(view) ? view : `box:${view}`;
      // The screen lists an unknown box as empty; the model is told instead.
      if (named !== view && !listLabels(deps.db).some((l) => l.id === view))
        throw new BadRequestError(`Vue inconnue : ${view}`);
      const page = await listMail(deps.db, mail().google, named, cursor);
      if (!page) throw new BadRequestError(`Vue inconnue : ${view}`);
      const body: { items: ReturnType<typeof summary>[]; cursor?: string } = {
        items: page.items.map((m) => summary(withProposal(deps.db, m))),
      };
      if (page.cursor) body.cursor = page.cursor;
      return body;
    },
  );
  add('write', 'mail.untrash', 'Sort un mail de la corbeille.', z.object({ id: Id }), ({ id }) =>
    journaled(id, { kind: 'untrash' }),
  );
  add('write', 'mail.spam', 'Signale un mail comme indésirable.', z.object({ id: Id }), ({ id }) =>
    journaled(id, { kind: 'spam' }),
  );
  add(
    'write',
    'mail.markRead',
    'Marque un mail comme lu ou non lu.',
    z.object({ id: Id, read: z.boolean() }),
    ({ id, read }) => journaled(id, { kind: 'read', read }),
  );

  // Drafts only: there is no action that sends a mail, and none may ever be added.
  const DraftFields = {
    to: headerValue.min(1),
    cc: headerValue.optional(),
    subject: z.string(),
    text: z.string(),
    replyTo: Id.optional().describe(
      'Pour répondre : l’id du mail renvoyé par mail.read ou mail.list ; le fil et l’adresse d’envoi en découlent',
    ),
  };
  type DraftInput = z.infer<z.ZodObject<typeof DraftFields>>;
  // `id` on update: without a replyTo, the draft keeps the sender it was written from.
  const toDraft = async (i: DraftInput, id?: string) => {
    const deps = mail();
    const kept = id && !i.replyTo ? (await getDraft(deps, id)).from : undefined;
    let reply: { inReplyTo?: string; references?: string; threadId: string } | undefined;
    if (i.replyTo) {
      const original = await fetchFull(deps.google, i.replyTo);
      if (!original) throw new NotFoundError();
      upsertMessage(deps.db, original);
      const messageId = header(original, 'Message-ID');
      const references = [header(original, 'References'), messageId].filter(Boolean).join(' ');
      reply = stripUndefined({
        inReplyTo: messageId || undefined,
        references: references || undefined,
        threadId: original.threadId,
      });
    }
    return stripUndefined({
      from: kept ?? (await defaultFrom(deps, i.replyTo)).default,
      to: i.to,
      cc: i.cc,
      subject: i.subject,
      html: textToHtml(i.text),
      text: i.text,
      ...reply,
    });
  };
  add(
    'read',
    'draft.read',
    'Lit un brouillon : destinataires, objet et texte.',
    z.object({ id: Id }),
    ({ id }) => getDraft(mail(), id),
  );
  add(
    'write',
    'draft.create',
    'Prépare un brouillon de mail (jamais envoyé : CrOliX le relit et l’envoie lui-même).',
    z.object(DraftFields),
    async (i) => createDraft(mail(), await toDraft(i)),
  );
  add(
    'write',
    'draft.update',
    'Remplace le contenu d’un brouillon.',
    z.object({ id: Id, ...DraftFields }),
    async ({ id, ...i }) => updateDraft(mail(), id, await toDraft(i, id)),
  );
  add('delete', 'draft.delete', 'Supprime un brouillon.', z.object({ id: Id }), ({ id }) =>
    deleteDraft(mail(), id),
  );

  add(
    'read',
    'label.list',
    'Liste les étiquettes avec leur rôle (boîte, étiquette ou aucun).',
    z.object({}),
    () => Promise.resolve({ labels: listLabels(deps.db) }),
  );
  add(
    'write',
    'label.create',
    'Crée une boîte ou une étiquette.',
    z.object({ name: z.string().trim().min(1), role: RoleSchema }),
    ({ name, role }) => createLabel(mail(), name, role),
  );
  add(
    'write',
    'label.setRole',
    'Change le rôle d’une étiquette (`box`, `tag`, ou null pour aucun).',
    z.object({ id: Id, role: RoleSchema.nullable() }),
    async ({ id, role }) => {
      setRole(deps.db, id, role);
      return listLabels(deps.db).find((l) => l.id === id);
    },
  );

  add('read', 'calendar.list', 'Liste les agendas synchronisés.', z.object({}), async () => ({
    items: listCalendars(deps.db),
  }));
  add('read', 'tasklist.list', 'Liste les listes de tâches.', z.object({}), async () => ({
    items: listTaskLists(deps.db),
  }));
  add(
    'read',
    'task.list',
    'Liste les tâches, faites ou non (d’une liste si listId est donné).',
    z.object({ listId: Id.optional() }),
    async ({ listId }) => ({
      items: allTasks(deps.db).filter((t) => !listId || t.listId === listId),
    }),
  );

  add(
    'read',
    'journal.list',
    'Journal du tri, du plus récent au plus ancien.',
    z.object({ limit: z.number().int().min(1).max(200).optional() }),
    async ({ limit }) => listJournal(deps.db, undefined, limit),
  );
  add(
    'write',
    'journal.undo',
    'Annule une entrée du journal du tri.',
    z.object({ id: z.number().int() }),
    ({ id }) => undo(mail(), id),
  );

  add('read', 'rule.list', 'Liste les règles de tri.', z.object({}), async () => ({
    rules: listRules(deps.db),
  }));
  add('write', 'rule.create', 'Crée une règle de tri.', RuleSchema, async (input) =>
    createRule(deps.db, stripUndefined(input)),
  );
  add(
    'write',
    'rule.update',
    'Modifie une règle (seuls les champs donnés changent).',
    RuleSchema.partial().extend({ id: z.number().int(), position: z.number().int().optional() }),
    async ({ id, ...patch }) => updateRule(deps.db, id, stripUndefined(patch)),
  );
  add(
    'delete',
    'rule.delete',
    'Supprime une règle de tri.',
    z.object({ id: z.number().int() }),
    async ({ id }) => {
      deleteRule(deps.db, id);
      return ok;
    },
  );

  add('read', 'stats.today', 'Ce que le tri a fait aujourd’hui.', z.object({}), async () =>
    todayStats(deps.db, deps.clock()),
  );

  add(
    'read',
    'day.digest',
    'Bilan d’une période [since, until[ : mails reçus, ce qui a été fait, et ce qui attend.',
    z.object({
      since: z.iso.datetime({ offset: true }).describe('Début inclus, ISO 8601 UTC'),
      until: z.iso.datetime({ offset: true }).describe('Fin exclue, ISO 8601 UTC'),
    }),
    async (input) => {
      const t = { since: Date.parse(input.since), until: Date.parse(input.until) };
      if (t.since >= t.until) throw new InvalidInputError('since doit précéder until');
      const [since, until] = [new Date(t.since).toISOString(), new Date(t.until).toISOString()];
      // shortcut: 200 items per list, newest first; a busier period loses its oldest, narrow the period.
      const LIMIT = 200;
      const received = (
        deps.db
          .prepare(
            'SELECT id, subject, internal_date FROM messages WHERE internal_date >= ? AND internal_date < ? ORDER BY internal_date DESC LIMIT ?',
          )
          .all(t.since, t.until, LIMIT) as { id: string; subject: string; internal_date: number }[]
      ).map((m) => {
        const at = new Date(m.internal_date).toISOString();
        return { type: 'mail', title: m.subject, at, ref: { type: 'mail', id: m.id, title: m.subject } };
      });
      const journal = (
        deps.db
          .prepare(
            `SELECT j.at, j.message_id, j.action, m.subject FROM journal j LEFT JOIN messages m ON m.id = j.message_id
             WHERE j.at >= ? AND j.at < ? AND j.undone_at IS NULL ORDER BY j.at DESC LIMIT ?`,
          )
          .all(since, until, LIMIT) as {
          at: string;
          message_id: string;
          action: string;
          subject: string | null;
        }[]
      ).map((j) => {
        const title = j.subject ?? j.message_id;
        return {
          type: `journal.${j.action}`,
          title,
          at: j.at,
          ref: { type: 'mail', id: j.message_id, title },
        };
      });
      const cards = deps.db
        .prepare(
          "SELECT * FROM pina_cards WHERE status = 'done' AND decided_at >= ? AND decided_at < ? ORDER BY decided_at DESC LIMIT ?",
        )
        .all(since, until, LIMIT)
        .map((r) => getCard(deps.db, r.id as number))
        .filter((c) => c !== undefined)
        .map((c) => ({ type: `card.${c.action}`, title: cardText(deps.db, c).title, at: c.decidedAt! }));
      const done = [...journal, ...cards].sort((a, b) => b.at.localeCompare(a.at)).slice(0, LIMIT);
      expireCards(deps.db, dayOf(deps.clock()));
      const count = (sql: string) => (deps.db.prepare(sql).get() as { n: number }).n;
      const pending =
        count("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'") +
        count("SELECT COUNT(*) AS n FROM pina_cards WHERE status = 'pending'");
      return { since, until, received, done, pending };
    },
  );
}
