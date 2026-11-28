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
import { plainText, stripHidden } from '../gmail/body.ts';
import { defaultFrom, headerValue, textToHtml } from '../gmail/compose.ts';
import { createDraft, deleteDraft, getDraft, updateDraft } from '../gmail/drafts.ts';
import { fetchFull, listMail, readMail, searchMail, summary } from '../gmail/read.ts';
import type { GoogleClient } from '../google/client.ts';
import { getStoredMessage, header, upsertMessage, viewFilter } from '../gmail/store.ts';
import type { MailDetail } from '../types.ts';
import { listJournal, todayStats, undo } from '../triage/journal.ts';
import { createLabel, listBoxes, listLabels, setRole } from '../triage/labels.ts';
import { mask } from '../triage/mask.ts';
import { digestCap, getProposal, saveSynthesis } from '../triage/proposals.ts';
import {
  afterUserAction,
  correct,
  creditExhausted,
  refuse,
  validate,
  withProposal,
} from '../triage/pipeline.ts';
import {
  ClassifierError,
  CreditExhaustedError,
  KeyRefusedError,
  type Classifier,
} from '../triage/classifier.ts';
import { dropCopied } from '../triage/mask.ts';
import { keyRefused } from '../llm/keys.ts';
import { costOf, priceOf, spentToday } from '../llm/models.ts';
import { recordCost } from './costs.ts';
import { getState } from './state.ts';
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

/** A mail's current box: the first of its labels that has the role `box` (`m` is the mail's row). */
const BOX_OF = `(SELECT j.value FROM json_each(m.label_ids) j JOIN label_roles r ON r.label_id = j.value
  AND r.role = 'box' ORDER BY j.key LIMIT 1)`;
/** A mail `day.digest` keeps with `boxes` (its one parameter, a JSON array): in one of them, not thrown away, filed
 * by a rule or with CrOliX's accord. */
const KEPT = `${BOX_OF} IN (SELECT value FROM json_each(?))
  AND NOT EXISTS (SELECT 1 FROM json_each(m.label_ids) WHERE value IN ('TRASH', 'SPAM'))
  AND EXISTS (SELECT 1 FROM proposals p WHERE p.message_id = m.id
    AND ((p.source = 'rule' AND p.status = 'auto') OR p.status IN ('accepted', 'corrected')))`;

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
interface CatalogDeps {
  db: DatabaseSync;
  google: GoogleClient | undefined;
  clock: () => Date;
  /** The triage's classifier, looked up at each use: the digest makes the missing syntheses with it. */
  classifier?: (() => Classifier | undefined) | undefined;
}

// shortcut: 10 syntheses per digest, the next digest goes on from there; raise it if the core asks for long periods.
export const DIGEST_PER_CALL = 10;
// shortcut: no new synthesis after 20 s, so that the core's call answers in time; raise it for a slower model.
export const DIGEST_TIME_MS = 20_000;
/** A digest is making syntheses: a second one, meanwhile, makes none (one process only). */
let summarizing = false;

/**
 * Writes the synthesis of the kept mails that have none (`null` first, then `[]`, the oldest first): never in a
 * pause, degraded, without Google or a classifier that summarizes, nor past the day's cap of the `digest` use,
 * read again before each call. A refused key or an exhausted credit stops it; a transient failure too, and the
 * digest answers all the same; an unreadable answer skips the mail.
 */
async function summarizeMissing(deps: CatalogDeps, ids: string[]): Promise<void> {
  const classifier = deps.classifier?.();
  const state = getState(deps.db);
  if (summarizing || !deps.google || !classifier?.summarize || state.paused || state.degraded.length) return;
  const google = deps.google;
  const missing = deps.db
    .prepare(
      `SELECT p.message_id AS id FROM proposals p JOIN messages m ON m.id = p.message_id
       WHERE p.message_id IN (SELECT value FROM json_each(?)) AND p.synthesis IS NULL
       ORDER BY m.internal_date LIMIT ?`,
    )
    .all(JSON.stringify(ids), DIGEST_PER_CALL) as { id: string }[];
  const provider = classifier.provider ?? 'anthropic';
  const start = deps.clock().getTime();
  summarizing = true;
  try {
    for (const { id } of missing) {
      if (deps.clock().getTime() - start >= DIGEST_TIME_MS) break;
      if (spentToday(deps.db, 'digest', deps.clock()) >= digestCap(deps.db)) break;
      let payload: Awaited<ReturnType<typeof fetchFull>>;
      let summary: Awaited<ReturnType<NonNullable<Classifier['summarize']>>>;
      try {
        payload = await fetchFull(google, id);
        const stored = getStoredMessage(deps.db, id);
        if (!payload?.payload || !stored) continue;
        // shortcut: no timeout on one call, DIGEST_TIME_MS is read between calls only; the provider's own
        // timeout bounds it. Pass an AbortSignal through Classifier.summarize if a digest is seen to hang.
        summary = await classifier.summarize({
          mail: {
            from: header(payload, 'From'),
            to: header(payload, 'To'),
            subject: stored.subject,
            date: stored.date,
            text: stripHidden(plainText(payload.payload)),
          },
        });
      } catch (err) {
        if (err instanceof ClassifierError) {
          // An unreadable answer is final, as an empty one: [] is not asked again, and the call was paid.
          recordCost(
            deps.db,
            { provider, model: classifier.model, amount: 0, calls: 1 },
            deps.clock(),
            'digest',
          );
          saveSynthesis(deps.db, id, []);
          continue;
        }
        if (err instanceof CreditExhaustedError) creditExhausted({ db: deps.db, google, now: deps.clock });
        if (err instanceof KeyRefusedError) keyRefused(deps.db, provider, deps.clock());
        break;
      }
      const price = priceOf(deps.db, provider, classifier.model);
      recordCost(
        deps.db,
        { provider, model: classifier.model, amount: price ? costOf(price, summary.usage) : 0, calls: 1 },
        deps.clock(),
        'digest',
      );
      // The same text as the model read above: a copy is looked for in it.
      const text = stripHidden(plainText(payload.payload));
      saveSynthesis(deps.db, id, dropCopied(summary.synthesis, text).map(mask));
    }
  } finally {
    summarizing = false;
  }
}

export function registerCatalog(actions: ActionRegistry, deps: CatalogDeps): void {
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
    'write',
    'mail.refuse',
    'Refuse la proposition de tri d’un mail : il reste en boîte de réception.',
    z.object({ id: Id }),
    ({ id }) => refuse(mail(), id),
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
    'Liste une page d’une vue (inbox, pending, trash, spam, sent) ou d’une boîte (son id), du plus récent au plus ancien. Avec unread: true, seuls les non lus déjà en cache ; repasser unread avec le curseur.',
    z.object({ view: Id, cursor: z.string().optional(), unread: z.boolean().optional() }),
    async ({ view, cursor, unread }) => {
      // A bare box id is what label.list gives; the screen's own view name is `box:<id>`.
      const named = viewFilter(view) ? view : `box:${view}`;
      // The screen lists an unknown box as empty; the model is told instead.
      if (named !== view && !listLabels(deps.db).some((l) => l.id === view))
        throw new BadRequestError(`Vue inconnue : ${view}`);
      const page = await listMail(deps.db, mail().google, named, cursor, { unread: unread === true });
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
    'Prépare un brouillon de mail (jamais envoyé : l’utilisateur le relit et l’envoie lui-même).',
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

  add(
    'read',
    'stats.today',
    'Ce que le tri a fait aujourd’hui, ou sur une période [since, until[ (les deux ensemble, ou aucun).',
    z.object({
      since: z.iso.datetime({ offset: true }).optional().describe('Début inclus, ISO 8601 (Z ou décalage)'),
      until: z.iso.datetime({ offset: true }).optional().describe('Fin exclue, ISO 8601 (Z ou décalage)'),
    }),
    async ({ since, until }) => {
      if (!since && !until) return todayStats(deps.db, deps.clock());
      if (!since || !until) throw new InvalidInputError('since et until vont ensemble');
      if (Date.parse(since) >= Date.parse(until)) throw new InvalidInputError('since doit précéder until');
      return todayStats(deps.db, deps.clock(), { since: new Date(since), until: new Date(until) });
    },
  );

  add(
    'read',
    'day.digest',
    'Bilan d’une période [since, until[ : mails reçus, ce qui a été fait, et ce qui attend.',
    z
      .object({
        since: z.iso.datetime({ offset: true }).describe('Début inclus, ISO 8601 UTC'),
        until: z.iso.datetime({ offset: true }).describe('Fin exclue, ISO 8601 UTC'),
        boxes: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('Les boîtes gardées : les mails qui y sont, rangés avec l’accord de CrOliX'),
      })
      .strict(),
    async (input) => {
      const t = { since: Date.parse(input.since), until: Date.parse(input.until) };
      const boxes = input.boxes;
      // With `boxes`: the mails whose current box is asked for, filed by a rule or with CrOliX's accord.
      const kept = boxes ? `AND ${KEPT}` : '';
      const keptParams = boxes ? [JSON.stringify(boxes)] : [];
      const names = new Map(listBoxes(deps.db).map((b) => [b.id, b.name]));
      /** What a kept mail adds to its item: its box and its synthesis. */
      const extra = (id: string, box: string | null) => {
        if (!boxes || !box) return {};
        const synthesis = getProposal(deps.db, id)?.synthesis?.map(mask).join('\n');
        return { box: { id: box, name: names.get(box) ?? box }, ...(synthesis ? { synthesis } : {}) };
      };
      if (t.since >= t.until) throw new InvalidInputError('since doit précéder until');
      const [since, until] = [new Date(t.since).toISOString(), new Date(t.until).toISOString()];
      // shortcut: 200 items per list, newest first; a busier period loses its oldest, narrow the period.
      const LIMIT = 200;
      const receivedRows = deps.db
        .prepare(
          `SELECT m.id, m.subject, m.internal_date, ${BOX_OF} AS box FROM messages m
           WHERE m.internal_date >= ? AND m.internal_date < ? ${kept} ORDER BY m.internal_date DESC LIMIT ?`,
        )
        .all(t.since, t.until, ...keptParams, LIMIT) as {
        id: string;
        subject: string;
        internal_date: number;
        box: string | null;
      }[];
      const journalRows = deps.db
        .prepare(
          `SELECT j.at, j.message_id, j.action, m.subject, ${BOX_OF} AS box FROM journal j
           LEFT JOIN messages m ON m.id = j.message_id
           WHERE j.at >= ? AND j.at < ? AND j.undone_at IS NULL ${kept} ORDER BY j.at DESC LIMIT ?`,
        )
        .all(since, until, ...keptParams, LIMIT) as {
        at: string;
        message_id: string;
        action: string;
        subject: string | null;
        box: string | null;
      }[];
      if (boxes)
        await summarizeMissing(deps, [
          ...new Set([...receivedRows.map((m) => m.id), ...journalRows.map((j) => j.message_id)]),
        ]);
      const received = receivedRows.map((m) => {
        const at = new Date(m.internal_date).toISOString();
        const title = mask(m.subject);
        return { type: 'mail', title, at, ref: { type: 'mail', id: m.id, title }, ...extra(m.id, m.box) };
      });
      const journal = journalRows.map((j) => {
        const title = mask(j.subject ?? j.message_id);
        return {
          type: `journal.${j.action}`,
          title,
          at: j.at,
          ref: { type: 'mail', id: j.message_id, title },
          ...extra(j.message_id, j.box),
        };
      });
      // The agent's cards are no mails: a digest by box leaves them out.
      const cards = boxes
        ? []
        : deps.db
            .prepare(
              "SELECT * FROM pina_cards WHERE status = 'done' AND decided_at >= ? AND decided_at < ? ORDER BY decided_at DESC LIMIT ?",
            )
            .all(since, until, LIMIT)
            .map((r) => getCard(deps.db, r.id as number))
            .filter((c) => c !== undefined)
            .map((c) => ({
              type: `card.${c.action}`,
              title: mask(cardText(deps.db, c).title),
              at: c.decidedAt!,
            }));
      const done = [...journal, ...cards].sort((a, b) => b.at.localeCompare(a.at)).slice(0, LIMIT);
      expireCards(deps.db, dayOf(deps.clock()), deps.clock());
      const count = (sql: string, params: string[] = []) =>
        (deps.db.prepare(sql).get(...params) as { n: number }).n;
      // What « À valider » shows: a proposal whose mail left the inbox waits for nobody.
      const waiting = viewFilter('pending')!;
      const pending =
        count(`SELECT COUNT(*) AS n FROM messages WHERE ${waiting.where}`, waiting.params) +
        count("SELECT COUNT(*) AS n FROM pina_cards WHERE status = 'pending'");
      return { since, until, received, done, pending };
    },
  );
}
