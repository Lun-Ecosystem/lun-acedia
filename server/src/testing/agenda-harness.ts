import { syncAgenda } from '../agenda/unified.ts';
import { FakeAgenda } from './fake-agenda.ts';
import { makeGmailHarness } from './gmail-harness.ts';

/** The Gmail harness plus an in-memory Google Calendar and Google Tasks. */
export async function makeAgendaHarness() {
  // The fake needs the harness clock, and the harness needs the fake's handler.
  const fake: { agenda?: FakeAgenda } = {};
  const h = await makeGmailHarness([], [(call) => fake.agenda!.handler(call)]);
  const agenda = (fake.agenda = new FakeAgenda(h.clock));
  return { ...h, agenda, syncAgenda: () => syncAgenda(h.deps) };
}

/** An ISO instant from a local date and time (the server's time zone). */
export const local = (y: number, month: number, d: number, h = 0, min = 0) =>
  new Date(y, month - 1, d, h, min).toISOString();
