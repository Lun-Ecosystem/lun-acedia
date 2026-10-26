import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../../views/src/testing/fake-client.ts';
import { EMPTY_STATUS, parisDay, readStatus, type ShellStatus } from './status.ts';

const start = EMPTY_STATUS;
const now = new Date('2026-11-02T10:00:00.000Z');

describe('readStatus', () => {
  it('counts the unread mails, the proposals and the open tasks due by today', async () => {
    const { client } = fakeClient();
    client.allTasks.mockResolvedValueOnce([
      { kind: 'task', id: 't1', listId: 'l', title: 'En retard', due: '2026-10-30', done: false },
      { kind: 'task', id: 't0', listId: 'l', title: 'Très en retard', due: '2026-01-15', done: false },
      { kind: 'task', id: 't2', listId: 'l', title: 'Faite', due: '2026-11-01', done: true },
      { kind: 'task', id: 't3', listId: 'l', title: 'Demain', due: '2026-11-03', done: false },
      { kind: 'task', id: 't4', listId: 'l', title: 'Un jour', done: false },
    ]);
    const status = await readStatus(client, start, { now });
    expect(status.counts).toEqual({ inbox: 5, pending: 1, tasks: 3 });
    expect(status).toMatchObject({ service: 'actif', detail: 'Seuil d’auto-rangement : 100 %' });
  });

  it('says a count is a lower bound when the list has more than one page', async () => {
    const { client } = fakeClient();
    const page = (await client.listMail('pending')).items;
    client.listMail.mockResolvedValue({ items: page, cursor: 'suite' });
    const status = await readStatus(client, start, { now });
    expect(status.counts.pending).toBe(String(page.length) + '+');
  });

  it('tells a pause, and a refused key before it', async () => {
    const { client } = fakeClient();
    client.health.mockResolvedValue({ status: 'paused' });
    expect((await readStatus(client, start, { now })).service).toBe('pause');
    client.getAnthropicKey.mockResolvedValueOnce({ state: 'refused', last4: '7f3a' });
    expect(await readStatus(client, start, { now })).toMatchObject({
      service: 'cle-refusee',
      detail: 'Clé refusée · les règles continuent',
    });
  });

  it('keeps the last values of what fails', async () => {
    const { client } = fakeClient();
    client.listMail.mockRejectedValue(new Error('hors ligne'));
    client.health.mockRejectedValueOnce(new Error('hors ligne'));
    const last: ShellStatus = {
      counts: { inbox: 7, pending: 2, tasks: 0 },
      service: 'pause',
      detail: 'x',
      paused: true,
    };
    expect(await readStatus(client, last, { now })).toMatchObject({
      counts: { inbox: 7, pending: 2 },
      service: 'pause',
      detail: 'x',
    });
  });

  it('keeps the pause apart from the card: a refused key and a pause still offer to resume', async () => {
    const { client } = fakeClient();
    client.health.mockResolvedValueOnce({ status: 'degraded', reason: 'anthropic-key', paused: true });
    client.getAnthropicKey.mockResolvedValueOnce({ state: 'refused', last4: '7f3a' });
    expect(await readStatus(client, start, { now })).toMatchObject({ service: 'cle-refusee', paused: true });
  });

  it('never shows a degraded service as active', async () => {
    const { client } = fakeClient();
    client.health.mockResolvedValueOnce({ status: 'degraded', reason: 'google-reauth' });
    expect(await readStatus(client, start, { now })).toMatchObject({
      service: 'pause',
      detail: 'Compte Google à reconnecter',
      paused: false,
    });
  });

  it('reads the tasks only when asked', async () => {
    const { client } = fakeClient();
    await readStatus(client, start, { now, tasks: false });
    expect(client.allTasks).not.toHaveBeenCalled();
    await readStatus(client, start, { now });
    expect(client.allTasks).toHaveBeenCalledOnce();
  });

  it('takes the calendar day in Paris, not in UTC', () => {
    expect(parisDay(new Date('2026-11-02T23:30:00.000Z'))).toBe('2026-11-03');
  });
});
