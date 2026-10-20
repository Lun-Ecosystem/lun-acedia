import { describe, expect, it } from 'vitest';
import { openDb } from '../db.ts';
import { pickExamples, recordExample } from './examples.ts';

const mail = (id: string, addr: string, subject = `Sujet ${id}`) => ({ id, from: { addr }, subject });

describe('pickExamples', () => {
  it('takes the same sender first, then the same domain, then the most recent', () => {
    const db = openDb(':memory:');
    const at = (min: number) => new Date(Date.UTC(2026, 10, 2, 8, min));
    recordExample(db, mail('a', 'other@x.fr'), 'B1', [], at(1));
    recordExample(db, mail('b', 'colleague@ecole.fr'), 'B2', [], at(2));
    recordExample(db, mail('c', 'prof@ecole.fr'), 'B3', ['T'], at(3));
    recordExample(db, mail('d', 'latest@y.fr'), 'B4', [], at(4));
    const picked = pickExamples(db, mail('new', 'prof@ecole.fr'), 3);
    expect(picked.map((e) => e.boxId)).toEqual(['B3', 'B2', 'B4']);
    expect(picked[0]).toEqual({ from: 'prof@ecole.fr', subject: 'Sujet c', boxId: 'B3', tagIds: ['T'] });
  });

  it('keeps only the latest gesture for a mail', () => {
    const db = openDb(':memory:');
    recordExample(db, mail('a', 'p@ecole.fr'), 'B1', [], new Date('2026-11-02T08:00:00Z'));
    recordExample(db, mail('a', 'p@ecole.fr'), 'B2', [], new Date('2026-11-02T09:00:00Z'));
    expect(pickExamples(db, mail('n', 'p@ecole.fr')).map((e) => e.boxId)).toEqual(['B2']);
  });

  it('returns at most 8 examples by default', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 12; i++)
      recordExample(db, mail(`m${i}`, `u${i}@x.fr`), 'B', [], new Date(2026, 10, 2, 8, i));
    expect(pickExamples(db, mail('n', 'z@z.fr'))).toHaveLength(8);
  });
});
