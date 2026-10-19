/** Dates without a time (`AAAA-MM-JJ`) are days in the server's time zone, like on Google Agenda. */
export const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Milliseconds of an instant, or of local midnight for a day. */
export function toMs(value: string): number {
  if (isDay(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d).getTime();
  }
  return Date.parse(value);
}

/** The local day of an instant, as `AAAA-MM-JJ`. */
export function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Accepts a day or an ISO instant; anything else is refused. */
export const isDateOrInstant = (value: string) => isDay(value) || !Number.isNaN(Date.parse(value));
