import type { DatabaseSync } from 'node:sqlite';
import { listLabels } from '../triage/labels.ts';
import { messagesOf, type Card } from './store.ts';
import { describe, targetsOf } from './wording.ts';

/** What a card says, named from its day's thread and the labels. */
export function cardText(db: DatabaseSync, card: Card) {
  const names = {
    labels: new Map(listLabels(db).map((l) => [l.id, l.name])),
    targets: targetsOf(messagesOf(db, card.day).map((m) => m.message)),
  };
  return describe(card, names);
}

/** One « Libellé : valeur » line per field of the card. */
export const cardLines = (db: DatabaseSync, card: Card): string[] =>
  cardText(db, card).fields.map((f) => `${f.label} : ${f.value}`);
