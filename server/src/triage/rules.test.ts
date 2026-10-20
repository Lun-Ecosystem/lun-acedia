import { describe, expect, it } from 'vitest';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import { matchRule, type Rule } from './rules.ts';

const mail = (from: string, subject = 'Bonjour', to = 'moi@example.com') => ({
  from: { addr: from },
  subject,
  to,
});

function rule(partial: Partial<Rule>): Rule {
  return {
    id: 1,
    field: 'from',
    op: 'equals',
    value: '',
    boxId: 'Label_1',
    tagIds: [],
    enabled: true,
    position: 1,
    ...partial,
  };
}

describe('matchRule', () => {
  it('matches a domain whatever the case', () => {
    const r = rule({ field: 'fromDomain', value: 'ecole.fr' });
    expect(matchRule([r], mail('prof@ECOLE.fr'))).toBe(r);
    expect(matchRule([r], mail('prof@autre.fr'))).toBeNull();
  });

  it('matches a subject containing a word, ignoring accents', () => {
    const r = rule({ field: 'subject', op: 'contains', value: 'echeance' });
    expect(matchRule([r], mail('a@b.fr', 'Votre ÉCHÉANCE approche'))).toBe(r);
  });

  it('matches an exact sender and a recipient', () => {
    const from = rule({ id: 1, field: 'from', value: 'noreply@impots.gouv.fr' });
    const to = rule({ id: 2, field: 'to', op: 'contains', value: 'contact@lun.example' });
    expect(matchRule([from], mail('NoReply@impots.gouv.fr'))).toBe(from);
    expect(matchRule([to], mail('x@y.fr', 's', "Lun'Ecosystem <contact@lun.example>"))).toBe(to);
  });

  it('ignores a disabled rule and takes the first by position', () => {
    const disabled = rule({ id: 1, position: 1, field: 'fromDomain', value: 'ecole.fr', enabled: false });
    const second = rule({ id: 2, position: 3, field: 'fromDomain', value: 'ecole.fr', boxId: 'B' });
    const first = rule({ id: 3, position: 2, field: 'fromDomain', value: 'ecole.fr', boxId: 'A' });
    expect(matchRule([disabled, second, first], mail('p@ecole.fr'))).toBe(first);
  });
});

describe('/api/rules', () => {
  it('creates, lists, updates and deletes a rule', async () => {
    const h = await makeGmailHarness();
    const box = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id;
    const created = await h.call('POST', '/api/rules', {
      field: 'fromDomain',
      op: 'equals',
      value: 'ecole.fr',
      boxId: box,
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      field: 'fromDomain',
      value: 'ecole.fr',
      boxId: box,
      enabled: true,
      tagIds: [],
    });
    await h.call('PATCH', `/api/rules/${created.body.id}`, { enabled: false });
    const list = await h.call('GET', '/api/rules');
    expect(list.body.rules).toHaveLength(1);
    expect(list.body.rules[0].enabled).toBe(false);
    await h.call('DELETE', `/api/rules/${created.body.id}`);
    expect((await h.call('GET', '/api/rules')).body.rules).toEqual([]);
  });

  it('refuses a rule towards a label that is not a box', async () => {
    const h = await makeGmailHarness();
    const { status } = await h.call('POST', '/api/rules', {
      field: 'from',
      op: 'equals',
      value: 'a@b.fr',
      boxId: 'INBOX',
    });
    expect(status).toBe(400);
  });
});
