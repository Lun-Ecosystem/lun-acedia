import { describe, expect, it } from 'vitest';
import { fakeClient } from '../../../views/src/testing/fake-client.ts';
import { readStatus, type ShellStatus } from './status.ts';

const start: ShellStatus = { counts: { inbox: 0, pending: 0, tasks: 0 }, service: 'actif', detail: '' };
const now = new Date('2026-11-02T10:00:00.000Z');

describe('readStatus', () => {
  it('counts the unread mails, the proposals and the open tasks due by today', async () => {
    const { client } = fakeClient();
    client.agenda.mockResolvedValueOnce([
      { kind: 'task', id: 't1', listId: 'l', title: 'En retard', due: '2026-10-30', done: false },
      { kind: 'task', id: 't2', listId: 'l', title: 'Faite', due: '2026-11-01', done: true },
      { kind: 'task', id: 't3', listId: 'l', title: 'Demain', due: '2026-11-03', done: false },
    ]);
    client.undatedTasks.mockResolvedValueOnce([
      { kind: 'task', id: 't4', listId: 'l', title: 'Un jour', done: false },
    ]);
    const status = await readStatus(client, start, now);
    expect(status.counts).toEqual({ inbox: 5, pending: 1, tasks: 2 });
    expect(status).toMatchObject({ service: 'actif', detail: 'Seuil d’auto-rangement : 100 %' });
  });

  it('tells a pause, and a refused key before it', async () => {
    const { client } = fakeClient();
    client.health.mockResolvedValue({ status: 'paused' });
    expect((await readStatus(client, start, now)).service).toBe('pause');
    client.getAnthropicKey.mockResolvedValueOnce({ state: 'refused', last4: '7f3a' });
    expect(await readStatus(client, start, now)).toMatchObject({
      service: 'cle-refusee',
      detail: 'Clé refusée · les règles continuent',
    });
  });

  it('keeps the last values of what fails', async () => {
    const { client } = fakeClient();
    client.listMail.mockRejectedValue(new Error('hors ligne'));
    client.health.mockRejectedValueOnce(new Error('hors ligne'));
    const last: ShellStatus = { counts: { inbox: 7, pending: 2, tasks: 0 }, service: 'pause', detail: 'x' };
    expect(await readStatus(client, last, now)).toMatchObject({
      counts: { inbox: 7, pending: 2 },
      service: 'pause',
      detail: 'x',
    });
  });
});
