import type { Hono } from 'hono';

/** A screen route is either served by a catalog action or left to the screen, with the reason. */
export type Parity = { action: string } | { excluded: string };

const SEND = 'Envoi : Pina n’envoie jamais, CrOliX relit et envoie lui-même';
const SETTINGS = 'Réglages et clés : à la main seulement';
const DEVICES = 'Appareils et codes : à la main seulement';
const FILE = 'Pièce jointe : binaire, sans usage pour Pina';

export const PARITY: Record<string, Parity> = {
  'POST /api/pairing-codes': { excluded: DEVICES },
  'GET /api/clients': { excluded: DEVICES },
  'DELETE /api/clients/:id': { excluded: DEVICES },
  'POST /api/authorizations': { excluded: DEVICES },
  'GET /api/llm/providers': { excluded: SETTINGS },
  'PUT /api/llm/providers/:id/key': { excluded: SETTINGS },
  'DELETE /api/llm/providers/:id/key': { excluded: SETTINGS },
  'GET /api/llm/models': { excluded: SETTINGS },
  'GET /api/llm/choice': { excluded: SETTINGS },
  'PUT /api/llm/choice': { excluded: SETTINGS },
  'GET /api/google/status': { excluded: SETTINGS },
  'GET /api/settings': { excluded: SETTINGS },
  'PUT /api/settings': { excluded: SETTINGS },
  'GET /api/mail': { action: 'mail.list' },
  'GET /api/mail/:id': { action: 'mail.read' },
  'GET /api/mail/:id/attachments/:partId': { excluded: FILE },
  'POST /api/mail/batch': { excluded: 'Lot de gestes que les actions mail couvrent déjà un par un' },
  'POST /api/mail/send': { excluded: SEND },
  'POST /api/mail/:id/file': { action: 'mail.file' },
  'POST /api/mail/:id/archive': { action: 'mail.archive' },
  'POST /api/mail/:id/trash': { action: 'mail.trash' },
  'POST /api/mail/:id/untrash': { action: 'mail.untrash' },
  'POST /api/mail/:id/spam': { action: 'mail.spam' },
  'POST /api/mail/:id/read': { action: 'mail.markRead' },
  'POST /api/mail/:id/tags': { action: 'mail.tags' },
  'POST /api/mail/:id/validate': { action: 'mail.validate' },
  'POST /api/mail/:id/correct': { action: 'mail.correct' },
  'POST /api/drafts': { action: 'draft.create' },
  'GET /api/drafts/:id': { action: 'draft.read' },
  'PUT /api/drafts/:id': { action: 'draft.update' },
  'DELETE /api/drafts/:id': { action: 'draft.delete' },
  'POST /api/drafts/:id/send': { excluded: SEND },
  'GET /api/send-as': { excluded: 'Adresses d’expéditeur : ne sert qu’à l’envoi' },
  'GET /api/labels': { action: 'label.list' },
  'POST /api/labels': { action: 'label.create' },
  'PATCH /api/labels/:id': { action: 'label.setRole' },
  'GET /api/rules': { action: 'rule.list' },
  'POST /api/rules': { action: 'rule.create' },
  'PATCH /api/rules/:id': { action: 'rule.update' },
  'DELETE /api/rules/:id': { action: 'rule.delete' },
  'GET /api/journal': { action: 'journal.list' },
  'POST /api/journal/:id/undo': { action: 'journal.undo' },
  'GET /api/stats/today': { action: 'stats.today' },
  'GET /api/agenda': { action: 'agenda.list' },
  'GET /api/calendars': { action: 'calendar.list' },
  'GET /api/task-lists': { action: 'tasklist.list' },
  'GET /api/tasks': { action: 'task.list' },
  'POST /api/events/:calendarId': { action: 'event.create' },
  'PATCH /api/events/:calendarId/:id': { action: 'event.update' },
  'DELETE /api/events/:calendarId/:id': { action: 'event.delete' },
  'POST /api/tasks/:listId': { action: 'task.create' },
  'PATCH /api/tasks/:listId/:id': { action: 'task.update' },
  'POST /api/tasks/:listId/:id/complete': { action: 'task.complete' },
  'DELETE /api/tasks/:listId/:id': { action: 'task.delete' },
};

/** Every `/api/*` handler of the app (middleware entries, method ALL, left out). */
export function screenRoutes(app: Hono): string[] {
  const keys = app.routes.filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/'));
  return [...new Set(keys.map((r) => `${r.method} ${r.path}`))];
}

/** Screen routes with no PARITY entry. */
export function missingFromParity(app: Hono): string[] {
  return screenRoutes(app).filter((k) => !(k in PARITY));
}
