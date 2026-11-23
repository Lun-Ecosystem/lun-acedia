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

  it('mail.refuse says what it refuses, and that the mail stays', () => {
    expect(text('mail.refuse', { id: 'm1' }, names([['m1', 'Rendu décalé']]))).toMatchObject({
      title: 'Refuser la proposition de tri',
      fields: [{ label: 'Mail', value: 'Rendu décalé' }],
      done: 'Proposition refusée',
    });
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

group('describe: the two cards of conflict', () => {
  const proposal = {
    calendarId: 'primary',
    id: 'a',
    start: '2026-11-04T10:30:00.000Z',
    end: '2026-11-04T11:30:00.000Z',
    conflit: { title: 'Dentiste', other: 'Réunion client' },
  };
  const signal = (reason: string) => ({
    from: '2026-11-04T09:30:00.000Z',
    to: '2026-11-04T10:00:00.000Z',
    conflit: { titles: ['Dentiste', 'Réunion client'], reason },
  });

  it('the card that proposes names both events, then Début and Fin, which « Modifier » opens', () => {
    const card = text('event.update', proposal);
    expect(card.title).toBe('Déplacer un événement qui en chevauche un autre');
    expect(card.done).toBe('Événement déplacé');
    expect(card.fields.map((f) => f.label)).toEqual(['Événement', 'Chevauche', 'Début', 'Fin']);
    expect(card.fields[0]!.value).toBe('Dentiste');
    expect(card.fields[1]!.value).toBe('Réunion client');
    expect(card.fields.filter((f) => f.key).map((f) => f.key)).toEqual(['start', 'end']);
  });

  it('an event.update without `conflit` keeps its usual wording', () => {
    expect(text('event.update', { calendarId: 'p', id: 'e1', location: 'Salle B' }).title).toBe(
      'Modifier un événement',
    );
  });

  it('the card that signals names both events and the reason, and has no field to edit', () => {
    const notMine = text('agenda.list', signal('not-mine'));
    expect(notMine.title).toBe('Deux événements se chevauchent');
    expect(notMine.done).toBe('Conflit vu');
    expect(notMine.fields.some((f) => f.key)).toBe(false);
    const said = notMine.fields.map((f) => f.value).join(' | ');
    expect(said).toContain('Dentiste');
    expect(said).toContain('Réunion client');
    expect(said).toContain('aucun des deux n’est à toi seul');
    const noSlot = text('agenda.list', signal('no-slot'))
      .fields.map((f) => f.value)
      .join(' | ');
    expect(noSlot).toContain('aucun créneau libre ce jour-là, de 8 h à 22 h');
    const series = text('agenda.list', signal('series'))
      .fields.map((f) => f.value)
      .join(' | ');
    expect(series).toContain('deux séries');
    expect(said).toContain('aucun des deux n’est à toi seul dans ton agenda principal');
    const moving = text('agenda.list', signal('moving'))
      .fields.map((f) => f.value)
      .join(' | ');
    expect(moving).toContain('l’un des deux a déjà une carte qui propose de le déplacer');
  });

  it('an agenda.list without `conflit` shows its name, as before', () => {
    expect(text('agenda.list', { from: '2026-11-04', to: '2026-11-05' }).title).toBe('agenda.list');
  });
});
