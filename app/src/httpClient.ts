import { httpClient, type AcediaClient } from '@lun-ecosystem/lunacedia-views/client';

export { ApiError, UnauthorizedError } from '@lun-ecosystem/lunacedia-views/client';

export interface HttpClientOptions {
  fetch?: typeof fetch;
  /** Called when the server refuses the token, so the app can ask to pair again. */
  onUnauthorized?: () => void;
}

/**
 * The client of the standalone app. Events arrive over a fetch stream, so the token travels in the
 * Authorization header and never in a URL.
 */
export function createHttpClient(baseUrl: string, token: string, opts: HttpClientOptions = {}): AcediaClient {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  return httpClient({
    baseUrl,
    token,
    fetch: async (input, init) => {
      const res = await doFetch(input, init);
      if (res.status === 401) opts.onUnauthorized?.();
      return res;
    },
  });
}
