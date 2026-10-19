import { randomBytes } from 'node:crypto';
import { createGoogleClient, saveTokens } from '../google/client.ts';
import { syncGmail } from '../gmail/sync.ts';
import { fakeFetch, type Handler } from './fake-fetch.ts';
import { FakeGmail, type FakeMessage } from './fake-gmail.ts';
import { makeHarness } from './harness.ts';

const secretKey = randomBytes(32).toString('base64');
const config = { clientId: 'id', clientSecret: 's', redirectUri: 'http://localhost/cb' };

/** An app connected to an in-memory Gmail (plus other fake Google APIs), synced once, with a paired client. */
export async function makeGmailHarness(initial: FakeMessage[] = [], handlers: Handler[] = []) {
  const gmail = new FakeGmail(initial);
  const fake = fakeFetch(gmail.handler, ...handlers);
  const h = makeHarness({ google: { config, secretKey, fetch: fake.fetch } });
  saveTokens(h.db, secretKey, { accessToken: 'a', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z' });
  const google = createGoogleClient({ db: h.db, fetch: fake.fetch, now: h.clock, config, secretKey });
  const deps = { db: h.db, google, now: h.clock };
  await syncGmail(deps);
  const token = await h.pairClient();
  return {
    ...h,
    gmail,
    calls: fake.calls,
    deps,
    sync: () => syncGmail(deps),
    async call(method: string, path: string, body?: unknown) {
      const init: RequestInit = { method, headers: h.auth(token) };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await h.app.request(path, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
  };
}
