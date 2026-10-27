import { describe, expect, it } from 'vitest';
import { eventsSince } from '../contract/events.ts';
import { getState, setPaused } from '../contract/state.ts';
import { putSetting } from '../db.ts';
import { getStoredMessage, upsertMessage } from '../gmail/store.ts';
import { message } from '../testing/fake-gmail.ts';
import { makeGmailHarness } from '../testing/gmail-harness.ts';
import {
  ClassifierError,
  CreditExhaustedError,
  KeyRefusedError,
  type Classification,
  type Classifier,
  type ClassifyInput,
} from './classifier.ts';
import { pickExamples } from './examples.ts';
import { getProposal, triageNew } from './pipeline.ts';
import { getSetting } from '../db.ts';
import { claim } from './proposals.ts';
import { queuedIds, recoverQueue } from './queue.ts';
import { createRule, listRules, updateRule } from './rules.ts';

/** A classifier that answers what the test decides and counts its calls. */
function fakeClassifier(answer: (input: ClassifyInput) => Partial<Classification> | Error) {
  const inputs: ClassifyInput[] = [];
  const classifier: Classifier = {
    model: 'claude-haiku-5-5',
    async classify(input) {
      inputs.push(input);
      await new Promise((r) => setTimeout(r, 5));
      const a = answer(input);
      if (a instanceof Error) throw a;
      return {
        boxId: null,
        tagIds: [],
        importance: 'normal',
        confidence: 50,
        reason: 'Expéditeur déjà vu.',
        usage: { inputTokens: 1000, outputTokens: 50 },
        ...a,
      };
    },
  };
  return { classifier, inputs };
}

async function setup(answer: Parameters<typeof fakeClassifier>[0]) {
  const h = await makeGmailHarness();
  const ecole = (await h.call('POST', '/api/labels', { name: 'École', role: 'box' })).body.id as string;
  const perso = (await h.call('POST', '/api/labels', { name: 'Perso', role: 'box' })).body.id as string;
  const urgent = (await h.call('POST', '/api/labels', { name: 'Urgent', role: 'tag' })).body.id as string;
  const fake = fakeClassifier(answer);
  const deliver = async (...msgs: Parameters<typeof message>[0][]) => {
    for (const m of msgs) h.gmail.deliver(message({ date: '2026-11-02T08:30:00.000Z', ...m }));
    return (await h.sync()).added;
  };
  const triage = (ids: string[]) => triageNew({ ...h.deps, classifier: fake.classifier }, ids);
  return { h, ecole, perso, urgent, fake, deliver, triage };
}

const journalCount = (h: Awaited<ReturnType<typeof makeGmailHarness>>) =>
  (h.db.prepare('SELECT COUNT(*) AS n FROM journal').get() as { n: number }).n;

describe('triageNew', () => {
  it('threshold 100: a 99 % proposal waits, nothing moves', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 99 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1' }));
    expect(getProposal(s.h.db, 'm1')).toMatchObject({ boxId: s.ecole, confidence: 99, status: 'pending' });
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain('INBOX');
    expect(journalCount(s.h)).toBe(0);
    const pending = await s.h.call('GET', '/api/mail?view=pending');
    expect(pending.body.items.map((m: { id: string }) => m.id)).toEqual(['m1']);
    expect(pending.body.items[0].proposal).toEqual({
      boxId: s.ecole,
      tagIds: [],
      confidence: 99,
      status: 'pending',
      reason: 'Expéditeur déjà vu.',
    });
  });

  it('a proposal without a reason (rule, or older) has no reason in the list', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1' }));
    s.h.db.prepare('UPDATE proposals SET reason = NULL WHERE message_id = ?').run('m1');
    const item = (await s.h.call('GET', '/api/mail?view=pending')).body.items[0];
    expect('reason' in item.proposal).toBe(false);
  });

  it('threshold 100: even a 100 % proposal waits, for a box, the trash or spam', async () => {
    const targets: string[] = [];
    const s = await setup(() => ({ boxId: targets.shift() ?? null, confidence: 100 }));
    targets.push(s.ecole, 'trash', 'spam');
    await s.triage(await s.deliver({ id: 'm1' }, { id: 'm2' }, { id: 'm3' }));
    for (const id of ['m1', 'm2', 'm3']) {
      expect(getProposal(s.h.db, id)).toMatchObject({ confidence: 100, status: 'pending' });
      expect(getStoredMessage(s.h.db, id)?.labels).toContain('INBOX');
    }
    expect(journalCount(s.h)).toBe(0);
  });

  it('threshold 80: an 85 % proposal is filed and journaled', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 85 }));
    box = s.ecole;
    putSetting(s.h.db, 'threshold', 80);
    await s.triage(await s.deliver({ id: 'm1' }));
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain(s.ecole);
    expect(getStoredMessage(s.h.db, 'm1')?.labels).not.toContain('INBOX');
    expect(getProposal(s.h.db, 'm1')?.status).toBe('auto');
    const journal = s.h.db.prepare('SELECT origin FROM journal').all() as { origin: string }[];
    expect(journal).toEqual([{ origin: 'ai' }]);
    const cost = s.h.db.prepare('SELECT provider, model, amount, calls FROM costs').all();
    expect(cost).toEqual([{ provider: 'anthropic', model: 'claude-haiku-5-5', amount: 0.000125, calls: 1 }]);
  });

  it("records triage costs with purpose 'triage'", async () => {
    const s = await setup(() => ({}));
    await s.triage(await s.deliver({ id: 'm1' }));
    expect(s.h.db.prepare('SELECT purpose FROM costs').all()).toEqual([{ purpose: 'triage' }]);
  });

  it('counts an unknown price as 0 and warns once per model', async () => {
    const s = await setup(() => ({}));
    const unpriced = { ...s.fake.classifier, model: 'mystery-1', provider: 'custom' as const };
    const ids = await s.deliver({ id: 'm1' }, { id: 'm2' });
    await triageNew({ ...s.h.deps, classifier: unpriced }, ids);
    expect(s.h.db.prepare('SELECT provider, model, amount FROM costs').all()).toEqual([
      { provider: 'custom', model: 'mystery-1', amount: 0 },
      { provider: 'custom', model: 'mystery-1', amount: 0 },
    ]);
    const warnings = eventsSince(s.h.db, '0').filter((e) => e.type === 'llm.unknown-price');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      importance: 'info',
      title: 'Prix inconnu pour mystery-1 : coût compté à 0',
    });
  });

  it('a matching rule files without calling the AI', async () => {
    const s = await setup(() => new Error('the classifier must not be called'));
    createRule(s.h.db, { field: 'fromDomain', op: 'equals', value: 'ecole.fr', boxId: s.ecole });
    await s.triage(await s.deliver({ id: 'm1', from: 'Prof <prof@ecole.fr>' }));
    expect(s.fake.inputs).toHaveLength(0);
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain(s.ecole);
    expect((s.h.db.prepare('SELECT origin FROM journal').get() as { origin: string }).origin).toBe('rule');
  });

  it('treats a mail once, even when asked twice at the same time', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 90 }));
    box = s.ecole;
    putSetting(s.h.db, 'threshold', 80);
    const ids = await s.deliver({ id: 'm1' });
    await Promise.all([s.triage(ids), s.triage(ids)]);
    await s.triage(ids);
    expect(s.fake.inputs).toHaveLength(1);
    expect((s.h.db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n).toBe(1);
    expect(journalCount(s.h)).toBe(1);
  });

  it('does nothing while paused, and triages the next mails after resuming', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 90 }));
    box = s.ecole;
    setPaused(s.h.db, true);
    await s.triage(await s.deliver({ id: 'm1' }));
    expect(s.fake.inputs).toHaveLength(0);
    expect(getProposal(s.h.db, 'm1')).toBeUndefined();
    setPaused(s.h.db, false);
    await s.triage(await s.deliver({ id: 'm2' }));
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(getProposal(s.h.db, 'm2')?.status).toBe('pending');
  });

  it('credit exhausted: degraded, mail left alone, rules still apply', async () => {
    const s = await setup(() => new CreditExhaustedError());
    createRule(s.h.db, { field: 'fromDomain', op: 'equals', value: 'ecole.fr', boxId: s.ecole });
    await s.triage(await s.deliver({ id: 'm1', from: 'x@ailleurs.fr' }, { id: 'm2', from: 'p@ecole.fr' }));
    expect(getState(s.h.db).degraded).toContain('credit');
    expect(getProposal(s.h.db, 'm1')).toBeUndefined();
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain('INBOX');
    expect(getStoredMessage(s.h.db, 'm2')?.labels).toContain(s.ecole);
    const credit = eventsSince(s.h.db).filter((e) => e.type === 'credit.exhausted');
    expect(credit).toHaveLength(1);
    expect(credit[0]!.importance).toBe('urgent');
  });

  it('lifts the credit state at the first successful call', async () => {
    let fail = true;
    let box = '';
    const s = await setup(() => (fail ? new CreditExhaustedError() : { boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1' }));
    fail = false;
    await s.triage(await s.deliver({ id: 'm2' }));
    expect(getState(s.h.db).degraded).not.toContain('credit');
  });

  it('a refused key pauses AI triage, rules go on, one key.invalid', async () => {
    const s = await setup(() => new KeyRefusedError());
    createRule(s.h.db, { field: 'fromDomain', op: 'equals', value: 'ecole.fr', boxId: s.ecole });
    await s.triage(
      await s.deliver(
        { id: 'm1', from: 'x@ailleurs.fr' },
        { id: 'm2', from: 'p@ecole.fr' },
        { id: 'm3', from: 'y@ailleurs.fr' },
      ),
    );
    await s.triage(await s.deliver({ id: 'm4', from: 'z@ailleurs.fr' }));
    expect(getState(s.h.db).degraded).toEqual(['anthropic-key']);
    expect(getProposal(s.h.db, 'm1')).toBeUndefined();
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain('INBOX');
    expect(getStoredMessage(s.h.db, 'm2')?.labels).toContain(s.ecole);
    expect(queuedIds(s.h.db)).toEqual(expect.arrayContaining(['m1', 'm3', 'm4']));
    const invalid = eventsSince(s.h.db).filter((e) => e.type === 'key.invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({
      importance: 'normal',
      title: 'Clé Anthropic refusée : le tri par l’IA est en pause, les règles continuent',
    });
    const health = await s.h.call('GET', '/lun/v1/health');
    expect(health.body).toMatchObject({ status: 'degraded', reason: 'anthropic-key' });
  });

  it('restart with the key still refused emits nothing new', async () => {
    const s = await setup(() => new KeyRefusedError());
    await s.triage(await s.deliver({ id: 'm1' }));
    // A restart: the claims go back to the queue, the state stays in the database.
    recoverQueue(s.h.db);
    await s.triage(await s.deliver({ id: 'm2' }));
    expect(s.fake.inputs.length).toBeGreaterThanOrEqual(2);
    expect(eventsSince(s.h.db).filter((e) => e.type === 'key.invalid')).toHaveLength(1);
    expect(getSetting(s.h.db, 'anthropic.keyState', 'ok')).toBe('refused');
  });

  it('a working call clears the state and emits key.restored', async () => {
    let refuse = true;
    let box = '';
    const s = await setup(() => (refuse ? new KeyRefusedError() : { boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1' }));
    refuse = false;
    await s.triage(await s.deliver({ id: 'm2' }));
    expect(getState(s.h.db).degraded).toEqual([]);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    const keyEvents = eventsSince(s.h.db).filter((e) => e.type.startsWith('key.'));
    expect(keyEvents.map((e) => e.type)).toEqual(['key.invalid', 'key.restored']);
    expect(keyEvents[1]).toMatchObject({ importance: 'info', title: 'Clé Anthropic de nouveau en service' });
    await s.triage(await s.deliver({ id: 'm3' }));
    expect(eventsSince(s.h.db).filter((e) => e.type === 'key.restored')).toHaveLength(1);
  });

  it('credit exhausted stays distinct from a refused key', async () => {
    const s = await setup(() => new CreditExhaustedError());
    await s.triage(await s.deliver({ id: 'm1' }));
    expect(getState(s.h.db).degraded).toEqual(['credit']);
    expect(eventsSince(s.h.db).map((e) => e.type)).not.toContain('key.invalid');
    const s2 = await setup(() => new KeyRefusedError());
    await s2.triage(await s2.deliver({ id: 'm1' }));
    expect(getState(s2.h.db).degraded).toEqual(['anthropic-key']);
    expect(eventsSince(s2.h.db).map((e) => e.type)).not.toContain('credit.exhausted');
  });

  it('a correction comes back first among the examples of the same sender', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1', from: 'Julie <julie@mail.fr>' }));
    expect((await s.h.call('POST', '/api/mail/m1/correct', { boxId: s.perso, tagIds: [] })).status).toBe(200);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('corrected');
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain(s.perso);
    await s.deliver({ id: 'm2', from: 'Julie <julie@mail.fr>' });
    const examples = pickExamples(s.h.db, getStoredMessage(s.h.db, 'm2')!);
    expect(examples[0]).toMatchObject({ from: 'julie@mail.fr', boxId: s.perso });
  });

  it('rememberSender creates one rule for the sender, even when asked twice', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1', from: 'Julie <Julie@Mail.fr>' }));
    await s.triage(await s.deliver({ id: 'm2', from: 'Julie <julie@mail.fr>' }));
    const body = { boxId: s.perso, tagIds: [], rememberSender: true };
    expect((await s.h.call('POST', '/api/mail/m1/correct', body)).status).toBe(200);
    expect((await s.h.call('POST', '/api/mail/m2/correct', body)).status).toBe(200);
    const rules = listRules(s.h.db);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ field: 'from', op: 'equals', value: 'julie@mail.fr', boxId: s.perso });
  });

  it('undoing a correction removes the rule it created, never a pre-existing one', async () => {
    const s = await setup(() => ({ boxId: null, confidence: 50 }));
    await s.triage(await s.deliver({ id: 'm1', from: 'Julie <julie@mail.fr>' }));
    await s.triage(await s.deliver({ id: 'm2', from: 'Julie <julie@mail.fr>' }));
    const body = { boxId: s.perso, tagIds: [], rememberSender: true };
    const first = await s.h.call('POST', '/api/mail/m1/correct', body);
    expect(listRules(s.h.db)).toHaveLength(1);
    expect((await s.h.call('POST', `/api/journal/${first.body.journalId}/undo`)).status).toBe(200);
    expect(listRules(s.h.db)).toHaveLength(0);
    // A rule that already existed is not the correction's: it survives the undo.
    createRule(s.h.db, { field: 'from', op: 'equals', value: 'julie@mail.fr', boxId: s.perso });
    const second = await s.h.call('POST', '/api/mail/m2/correct', body);
    expect(listRules(s.h.db)).toHaveLength(1);
    await s.h.call('POST', `/api/journal/${second.body.journalId}/undo`);
    expect(listRules(s.h.db)).toHaveLength(1);
  });

  it('undoing a correction leaves the created rule alone once CrOliX edited it', async () => {
    const s = await setup(() => ({ boxId: null, confidence: 50 }));
    await s.triage(await s.deliver({ id: 'm1', from: 'Julie <julie@mail.fr>' }));
    const body = { boxId: s.perso, tagIds: [], rememberSender: true };
    const res = await s.h.call('POST', '/api/mail/m1/correct', body);
    const rule = listRules(s.h.db)[0]!;
    updateRule(s.h.db, rule.id, { boxId: s.ecole });
    expect((await s.h.call('POST', `/api/journal/${res.body.journalId}/undo`)).status).toBe(200);
    expect(listRules(s.h.db)).toMatchObject([{ id: rule.id, boxId: s.ecole }]);
  });

  it('correcting without rememberSender creates no rule', async () => {
    const s = await setup(() => ({ boxId: null, confidence: 50 }));
    await s.triage(await s.deliver({ id: 'm1' }));
    await s.h.call('POST', '/api/mail/m1/correct', { boxId: s.perso, tagIds: [] });
    expect(listRules(s.h.db)).toHaveLength(0);
  });

  it('validating applies the proposal and keeps it as an example', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1' }));
    expect((await s.h.call('POST', '/api/mail/m1/validate')).status).toBe(200);
    expect(getStoredMessage(s.h.db, 'm1')?.labels).toContain(s.ecole);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('accepted');
    expect(pickExamples(s.h.db, getStoredMessage(s.h.db, 'm1')!)).toHaveLength(1);
  });

  it('a mail filed by hand settles its proposal and becomes an example', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1', from: 'Julie <julie@mail.fr>' }));
    expect((await s.h.call('POST', '/api/mail/m1/file', { boxId: s.perso })).status).toBe(200);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('corrected');
    expect((await s.h.call('GET', '/api/mail?view=pending')).body.items).toEqual([]);
    expect(pickExamples(s.h.db, getStoredMessage(s.h.db, 'm1')!)[0]).toMatchObject({ boxId: s.perso });
  });

  it('reads and changes the threshold', async () => {
    const s = await setup(() => ({}));
    expect((await s.h.call('GET', '/api/settings')).body).toEqual({ threshold: 100, bulkThreshold: 85 });
    expect((await s.h.call('PUT', '/api/settings', { threshold: 90 })).body).toEqual({
      threshold: 90,
      bulkThreshold: 85,
    });
    expect((await s.h.call('PUT', '/api/settings', { threshold: 120 })).status).toBe(400);
  });

  it('changes the bulk threshold alone, and refuses one above the threshold', async () => {
    const s = await setup(() => ({}));
    expect((await s.h.call('PUT', '/api/settings', { bulkThreshold: 70 })).body).toEqual({
      threshold: 100,
      bulkThreshold: 70,
    });
    const refused = await s.h.call('PUT', '/api/settings', { threshold: 80, bulkThreshold: 90 });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(
      'Le seuil de « Tout valider » ne peut pas dépasser le seuil d’auto-rangement',
    );
    expect((await s.h.call('GET', '/api/settings')).body).toEqual({ threshold: 100, bulkThreshold: 70 });
    expect((await s.h.call('PUT', '/api/settings', { bulkThreshold: 101 })).status).toBe(400);
  });

  it('lowering the threshold below the bulk threshold clamps the bulk threshold', async () => {
    const s = await setup(() => ({}));
    expect((await s.h.call('PUT', '/api/settings', { threshold: 80 })).body).toEqual({
      threshold: 80,
      bulkThreshold: 80,
    });
    expect((await s.h.call('GET', '/api/settings')).body).toEqual({ threshold: 80, bulkThreshold: 80 });
  });

  it('never sends a mail to spam below 95 %', async () => {
    const s = await setup(() => ({ boxId: 'spam', confidence: 90 }));
    putSetting(s.h.db, 'threshold', 50);
    await s.triage(await s.deliver({ id: 'm1' }));
    expect(getStoredMessage(s.h.db, 'm1')?.labels).not.toContain('SPAM');
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
  });

  it('emits no event for a mail of no interest, and proposes Urgent for an urgent one', async () => {
    let box = '';
    const s = await setup((input) =>
      input.mail.subject.includes('pub')
        ? { boxId: box, importance: 'none', confidence: 40 }
        : { boxId: box, importance: 'urgent', confidence: 40 },
    );
    box = s.ecole;
    const before = eventsSince(s.h.db).filter((e) => e.type.startsWith('mail.pending')).length;
    await s.triage(await s.deliver({ id: 'pub', subject: 'Une pub' }, { id: 'tax', subject: 'Impôts' }));
    const pending = eventsSince(s.h.db).filter((e) => e.type === 'mail.pending');
    expect(pending).toHaveLength(before + 1);
    expect(pending.at(-1)).toMatchObject({ importance: 'urgent', title: 'Impôts' });
    expect(getProposal(s.h.db, 'tax')?.tagIds).toEqual([s.urgent]);
  });

  it('gives the classifier the boxes, the tags and a text excerpt', async () => {
    const s = await setup(() => ({ confidence: 10 }));
    await s.triage(await s.deliver({ id: 'm1' }));
    const input = s.fake.inputs[0]!;
    expect(input.boxes.map((b) => b.name).sort()).toEqual(['Perso', 'École']);
    expect(input.tags.map((t) => t.name)).toEqual(['Urgent']);
    expect(input.mail.text).toBe('Bonjour');
    expect(input.mail.from).toBe('Prof Martin <prof@ecole.fr>');
  });
});

describe('triage queue', () => {
  it('a mail left alone during a credit outage is triaged once the credit is back', async () => {
    let fail = true;
    let box = '';
    const s = await setup(() => (fail ? new CreditExhaustedError() : { boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.triage(await s.deliver({ id: 'm1' }));
    expect(getProposal(s.h.db, 'm1')).toBeUndefined();
    fail = false;
    await s.triage([]);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
    expect(queuedIds(s.h.db)).toEqual([]);
  });

  it('a mail caught mid-triage by a restart is triaged after it', async () => {
    let box = '';
    const s = await setup(() => ({ boxId: box, confidence: 50 }));
    box = s.ecole;
    await s.deliver({ id: 'm1' });
    claim(s.h.db, 'm1', s.h.clock()); // the process died here
    recoverQueue(s.h.db);
    await s.triage([]);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
  });

  it('a transient failure keeps the mail queued for the next pass', async () => {
    let calls = 0;
    let box = '';
    const s = await setup(() =>
      ++calls === 1 ? new Error('Anthropic 529') : { boxId: box, confidence: 50 },
    );
    box = s.ecole;
    await expect(s.triage(await s.deliver({ id: 'm1' }))).rejects.toThrow('529');
    expect(queuedIds(s.h.db)).toEqual(['m1']);
    await s.triage([]);
    expect(getProposal(s.h.db, 'm1')?.status).toBe('pending');
  });

  it('gives up on a mail after three unusable answers', async () => {
    const s = await setup(() => new ClassifierError('réponse illisible'));
    await s.triage(await s.deliver({ id: 'm1' }));
    await s.triage([]);
    expect(queuedIds(s.h.db)).toEqual(['m1']);
    await s.triage([]);
    expect(queuedIds(s.h.db)).toEqual([]);
    expect(s.fake.inputs).toHaveLength(3);
  });

  it('triages a new mail even when it was cached before the sync saw it arrive', async () => {
    const s = await setup(() => ({ boxId: null, confidence: 50 }));
    const early = message({ id: 'm1', date: '2026-11-02T08:30:00.000Z' });
    s.h.gmail.deliver(early);
    upsertMessage(s.h.db, early); // read by the core through mail.read before the sync loop ran
    expect((await s.h.sync()).added).toEqual(['m1']);
  });
});
