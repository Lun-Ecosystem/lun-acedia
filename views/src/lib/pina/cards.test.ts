import { describe as group, expect, it } from 'vitest';
import type { PinaThread } from '../types.ts';
import { describe, targetsOf, type Names } from './cards.ts';

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
    const thread = {
      messages: [
        {
          message: {
            role: 'tool',
            isError: false,
            content: JSON.stringify({
              items: [{ id: 4, messageId: 'm1', origin: 'ai', subject: 'Facture octobre' }],
              rules: [{ id: 5, value: 'example.org' }],
            }),
          },
        },
      ],
      cards: [],
    } as unknown as PinaThread;
    const n = { labels: new Map(), targets: targetsOf(thread) };
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
