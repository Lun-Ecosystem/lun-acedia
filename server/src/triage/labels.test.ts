import { describe, expect, it } from 'vitest';
import { makeGmailHarness } from '../testing/gmail-harness.ts';

describe('boxes and tags', () => {
  it('creates a box: a Gmail label plus the box role', async () => {
    const h = await makeGmailHarness();
    const { status, body } = await h.call('POST', '/api/labels', { name: 'École', role: 'box' });
    expect(status).toBe(200);
    expect(h.gmail.labels.find((l) => l.name === 'École')?.id).toBe(body.id);
    expect(body).toEqual({ id: body.id, name: 'École', type: 'user', role: 'box' });
    const list = await h.call('GET', '/api/labels');
    expect(list.body.labels).toContainEqual({ id: body.id, name: 'École', type: 'user', role: 'box' });
  });

  it('adopts an existing Gmail label with the same name', async () => {
    const h = await makeGmailHarness();
    const existing = h.gmail.addLabel('Perso');
    const { body } = await h.call('POST', '/api/labels', { name: 'perso', role: 'tag' });
    expect(body.id).toBe(existing);
    expect(body.role).toBe('tag');
    expect(h.gmail.labels.filter((l) => l.name.toLowerCase() === 'perso')).toHaveLength(1);
  });

  it('changes or removes the role of a label', async () => {
    const h = await makeGmailHarness();
    const { body } = await h.call('POST', '/api/labels', { name: 'Urgent', role: 'box' });
    await h.call('PATCH', `/api/labels/${body.id}`, { role: 'tag' });
    let list = await h.call('GET', '/api/labels');
    expect(list.body.labels.find((l: { id: string }) => l.id === body.id).role).toBe('tag');
    await h.call('PATCH', `/api/labels/${body.id}`, { role: null });
    list = await h.call('GET', '/api/labels');
    expect(list.body.labels.find((l: { id: string }) => l.id === body.id).role).toBeUndefined();
  });

  it('refuses an empty name and an unknown role', async () => {
    const h = await makeGmailHarness();
    expect((await h.call('POST', '/api/labels', { name: ' ', role: 'box' })).status).toBe(400);
    expect((await h.call('POST', '/api/labels', { name: 'X', role: 'folder' })).status).toBe(400);
  });

  it('does not give a role to a system label', async () => {
    const h = await makeGmailHarness();
    expect((await h.call('PATCH', '/api/labels/INBOX', { role: 'box' })).status).toBe(400);
  });
});
