const KEY = 'lunacedia.token';
const CLIENT = "Lun'Acedia (app)";

/** The paired token, or null when the device is not paired or storage is unavailable. */
export function loadToken(storage: Storage): string | null {
  try {
    return storage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveToken(storage: Storage, token: string): void {
  storage.setItem(KEY, token);
}

export function clearToken(storage: Storage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/** Exchanges a one-time pairing code for the device's token. */
export async function pair(
  baseUrl: string,
  code: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<string> {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/lun/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), client: CLIENT }),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? `Erreur ${res.status}`);
  return body.token;
}
