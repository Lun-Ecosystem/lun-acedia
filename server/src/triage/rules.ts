import type { DatabaseSync } from 'node:sqlite';
import { BadRequestError, boxIds } from '../gmail/actions.ts';
import type { Address, Rule, RuleField, RuleOp } from '../types.ts';

export type { RuleField, RuleOp, Rule };

export type RuleInput = Omit<Rule, 'id' | 'position' | 'enabled' | 'tagIds'> & {
  tagIds?: string[];
  enabled?: boolean;
};

/** What a rule looks at in a mail. */
export interface RuleTarget {
  from: Address;
  to: string;
  subject: string;
}

/** Lower case, accents removed: « ÉCHÉANCE » and « echeance » compare equal. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function fieldValues(rule: Rule, mail: RuleTarget): string[] {
  switch (rule.field) {
    case 'from':
      return [mail.from.addr];
    case 'fromDomain':
      return [mail.from.addr.split('@')[1] ?? ''];
    case 'subject':
      return [mail.subject];
    case 'to':
      return mail.to
        .split(',')
        .map((r) => r.match(/<([^>]+)>/)?.[1] ?? r)
        .concat(mail.to);
  }
}

/** The first enabled rule, by position, that matches the mail; `null` when none does. */
export function matchRule(rules: Rule[], mail: RuleTarget): Rule | null {
  const sorted = rules.filter((r) => r.enabled).sort((a, b) => a.position - b.position);
  for (const rule of sorted) {
    const wanted = normalize(rule.value);
    if (!wanted) continue;
    const values = fieldValues(rule, mail).map(normalize);
    if (values.some((v) => (rule.op === 'equals' ? v === wanted : v.includes(wanted)))) return rule;
  }
  return null;
}

interface Row {
  id: number;
  field: RuleField;
  op: RuleOp;
  value: string;
  box_label_id: string;
  tag_ids: string;
  enabled: number;
  position: number;
}

const toRule = (r: Row): Rule => ({
  id: r.id,
  field: r.field,
  op: r.op,
  value: r.value,
  boxId: r.box_label_id,
  tagIds: JSON.parse(r.tag_ids) as string[],
  enabled: r.enabled === 1,
  position: r.position,
});

export function listRules(db: DatabaseSync): Rule[] {
  return (db.prepare('SELECT * FROM rules ORDER BY position').all() as unknown as Row[]).map(toRule);
}

function checkBox(db: DatabaseSync, boxId: string): void {
  if (!boxIds(db).includes(boxId)) throw new BadRequestError(`« ${boxId} » n’est pas une boîte`);
}

export function createRule(db: DatabaseSync, input: RuleInput): Rule {
  checkBox(db, input.boxId);
  const position =
    ((db.prepare('SELECT MAX(position) AS p FROM rules').get() as { p: number | null }).p ?? 0) + 1;
  const info = db
    .prepare(
      'INSERT INTO rules (field, op, value, box_label_id, tag_ids, enabled, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.field,
      input.op,
      input.value,
      input.boxId,
      JSON.stringify(input.tagIds ?? []),
      input.enabled === false ? 0 : 1,
      position,
    );
  return listRules(db).find((r) => r.id === Number(info.lastInsertRowid))!;
}

export function updateRule(
  db: DatabaseSync,
  id: number,
  patch: Partial<RuleInput & { position: number }>,
): Rule {
  const current = listRules(db).find((r) => r.id === id);
  if (!current) throw new BadRequestError(`Règle inconnue : ${id}`);
  const next = { ...current, ...patch };
  checkBox(db, next.boxId);
  db.prepare(
    'UPDATE rules SET field = ?, op = ?, value = ?, box_label_id = ?, tag_ids = ?, enabled = ?, position = ? WHERE id = ?',
  ).run(
    next.field,
    next.op,
    next.value,
    next.boxId,
    JSON.stringify(next.tagIds),
    next.enabled ? 1 : 0,
    next.position,
    id,
  );
  return listRules(db).find((r) => r.id === id)!;
}

export function deleteRule(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
}
