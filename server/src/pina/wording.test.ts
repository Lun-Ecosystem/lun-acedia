import { describe as group, expect, it } from 'vitest';
import { openDb } from '../db.ts';
import { addCard, appendMessage, getCard } from './store.ts';
import { cardLines } from './lines.ts';
import type { ChatMessage } from '../llm/types.ts';
import { describe, targetsOf, type Names } from './wording.ts';

const names = (targets: [string, string][] = [], labels: [string, string][] = []): Names => ({
  labels: new Map(labels),
  targets: new Map(targets.map(([id, name]) => [id, { name }])),
});
const text = (action: string, input: Record<string, unknown>, n = names()) => describe({ action, input }, n);
const fields = (action: string, input: Record<string, unknown>, n = names()) =>
  text(action, input, n).fields.map((f) => `${f.label} : ${f.value}`);

group('describe: every write card names what it acts on', () => {
  it('a mail gesture shows the subject, else the id', () => {
    expect(fields('mail.archive', { id: 'm1' }, names([['m1', 'Rendu décalé']]))).toEqual([
      'Mail : Rendu décalé',
    ]);
    expect(fields('mail.archive', { id: 'm1' })).toEqual(['Identifiant : m1']);
  });

  it('task.complete names the task', () => {
    expect(fields('task.complete', { listId: 'l', id: 't1' }, names([['t1', 'Appeler la banque']]))).toEqual([
      'Tâche : Appeler la banque',
    ]);
    expect(fields('task.complete', { listId: 'l', id: 't1' })).toEqual(['Identifiant : t1']);
  });

  it('task.update {done} says « Cocher » or « Décocher » with the task', () => {
    const n = names([['t1', 'Appeler la banque']]);
    expect(text('task.update', { listId: 'l', id: 't1', done: true }, n)).toMatchObject({
      title: 'Cocher une tâche',
      fields: [{ label: 'Tâche', value: 'Appeler la banque' }],
    });
    expect(text('task.update', { listId: 'l', id: 't1', done: false }, n).title).toBe('Décocher une tâche');
  });

  it('an update names the object and shows the patched fields', () => {
    expect(
      fields('event.update', { calendarId: 'p', id: 'e1', location: 'Salle B' }, names([['e1', 'Réunion']])),
    ).toEqual(['Événement : Réunion', 'Lieu : Salle B']);
    expect(fields('task.update', { listId: 'l', id: 't1', notes: 'Avant midi' })).toEqual([
      'Identifiant : t1',
      'Notes : Avant midi',
    ]);
    expect(
      fields(
        'rule.update',
        { id: 3, field: 'fromDomain', op: 'contains', value: 'example.org' },
        names([['3', 'ancienne']]),
      ),
    ).toEqual([
      'Règle : ancienne',
      'Champ : Domaine de l’expéditeur',
      'Condition : contient',
      'Valeur : example.org',
    ]);
  });

  it('rule.create shows field, condition and value', () => {
    expect(
      fields(
        'rule.create',
        { field: 'from', op: 'equals', value: 'a@example.org', boxId: 'B' },
        names([], [['B', 'Administratif']]),
      ),
    ).toEqual([
      'Champ : Expéditeur',
      'Condition : est exactement',
      'Valeur : a@example.org',
      'Boîte : Administratif',
    ]);
  });

  it('label.setRole shows the label and its new role', () => {
    const n = names([], [['L1', 'Factures']]);
    expect(fields('label.setRole', { id: 'L1', role: 'tag' }, n)).toEqual([
      'Libellé : Factures',
      'Nouveau rôle : Étiquette',
    ]);
    expect(fields('label.setRole', { id: 'L9', role: null })).toEqual([
      'Identifiant : L9',
      'Nouveau rôle : aucun rôle',
    ]);
  });

  it('journal.undo names the entry it undoes, never a rule with the same id', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        callId: 'c',
        isError: false,
        content: JSON.stringify({
          items: [{ id: 4, messageId: 'm1', origin: 'ai', subject: 'Facture octobre' }],
          rules: [{ id: 5, value: 'example.org' }],
        }),
      },
    ];
    const n = { labels: new Map(), targets: targetsOf(messages) };
    expect(fields('journal.undo', { id: 4 }, n)).toEqual(['Annule : Facture octobre']);
    expect(fields('journal.undo', { id: 5 }, n)).toEqual(['Identifiant : 5']);
  });

  it('a draft shows its copy, and an update the draft it replaces', () => {
    expect(
      fields('draft.create', { to: 'a@example.org', cc: 'b@example.org', subject: 'S', text: 'T' }),
    ).toEqual(['À : a@example.org', 'Copie : b@example.org', 'Objet : S', 'Texte : T']);
    expect(fields('draft.update', { id: 'd1', to: 'a@example.org', subject: 'S', text: 'T' })[0]).toBe(
      'Identifiant : d1',
    );
  });
});

group('cardLines', () => {
  const day = '2026-07-01';
  const now = new Date('2026-07-01T10:00:00Z');
  const make = (action: string, input: unknown) => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO labels (id, name, type) VALUES ('L1', 'Factures', 'user')").run();
    appendMessage(
      db,
      day,
      {
        role: 'tool',
        callId: 'c',
        isError: false,
        content: JSON.stringify({ id: 'm1', subject: 'Facture octobre' }),
      },
      now,
    );
    appendMessage(
      db,
      day,
      {
        role: 'tool',
        callId: 'd',
        isError: false,
        content: JSON.stringify({ id: 'e1', title: 'Réunion', start: '2026-07-02' }),
      },
      now,
    );
    const id = addCard(db, { day, turn: 1, callId: 'x', action, input, effect: 'write', now });
    return { db, card: getCard(db, id)! };
  };

  it('a mail.file card names the mail and the box', () => {
    const { db, card } = make('mail.file', { id: 'm1', boxId: 'L1' });
    expect(cardLines(db, card)).toEqual(['Mail : Facture octobre', 'Boîte : Factures']);
  });

  it('an event.delete card gives the event line', () => {
    const { db, card } = make('event.delete', { id: 'e1' });
    const lines = cardLines(db, card);
    expect(lines).toHaveLength(3);
    expect([lines[0], lines[2]]).toEqual(['Événement : Réunion', 'Identifiant : e1']);
  });
});
