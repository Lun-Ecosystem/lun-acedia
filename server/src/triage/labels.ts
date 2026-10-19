import type { DatabaseSync } from 'node:sqlite';
import { BadRequestError, type ActionDeps } from '../gmail/actions.ts';
import { saveLabels } from '../gmail/store.ts';
import { GMAIL_API } from '../gmail/sync.ts';
import { GoogleApiError } from '../google/client.ts';
import type { Role, LabelView } from '../types.ts';

export type { Role, LabelView };

export function listLabels(db: DatabaseSync): LabelView[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.name, l.type, r.role FROM labels l LEFT JOIN label_roles r ON r.label_id = l.id
       ORDER BY l.type DESC, l.name`,
    )
    .all() as { id: string; name: string; type: string; role: Role | null }[];
  return rows.map((r) => {
    const view: LabelView = { id: r.id, name: r.name, type: r.type };
    if (r.role) view.role = r.role;
    return view;
  });
}

function byRole(db: DatabaseSync, role: Role): { id: string; name: string }[] {
  return listLabels(db)
    .filter((l) => l.role === role)
    .map(({ id, name }) => ({ id, name }));
}

export const listBoxes = (db: DatabaseSync) => byRole(db, 'box');
export const listTags = (db: DatabaseSync) => byRole(db, 'tag');

/** Gives a role to a user label, or removes it (`null`). System labels (INBOX…) never get one. */
export function setRole(db: DatabaseSync, labelId: string, role: Role | null): void {
  const label = listLabels(db).find((l) => l.id === labelId);
  if (!label) throw new BadRequestError(`Libellé inconnu : ${labelId}`);
  if (label.type === 'system')
    throw new BadRequestError('Un libellé système ne peut pas être une boîte ou une étiquette');
  if (role === null) db.prepare('DELETE FROM label_roles WHERE label_id = ?').run(labelId);
  else {
    db.prepare(
      'INSERT INTO label_roles (label_id, role) VALUES (?, ?) ON CONFLICT(label_id) DO UPDATE SET role = excluded.role',
    ).run(labelId, role);
  }
}

async function refreshLabels(deps: ActionDeps): Promise<void> {
  const { labels } = await deps.google.request<{ labels: { id: string; name: string; type: string }[] }>(
    'GET',
    `${GMAIL_API}/labels`,
  );
  saveLabels(deps.db, labels);
}

/** Creates the Gmail label (or adopts the existing one with that name) and gives it its role. */
export async function createLabel(deps: ActionDeps, name: string, role: Role): Promise<LabelView> {
  const clean = name.trim();
  if (!clean) throw new BadRequestError('Nom vide');
  try {
    await deps.google.request('POST', `${GMAIL_API}/labels`, {
      name: clean,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
  } catch (err) {
    if (!(err instanceof GoogleApiError && err.status === 409)) throw err;
  }
  await refreshLabels(deps);
  const label = listLabels(deps.db).find((l) => l.name.toLowerCase() === clean.toLowerCase());
  if (!label) throw new Error(`Libellé « ${clean} » introuvable après création`);
  setRole(deps.db, label.id, role);
  return { ...label, role };
}
