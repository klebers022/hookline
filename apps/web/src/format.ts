const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function formatDate(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : '—';
}

export function formatTime(value: string | null): string {
  return value ? time.format(new Date(value)) : '—';
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

// "2 minutes ago", "in 28 minutes": how far a moment is from now, in the
// largest whole unit. Under a minute is "now", and past a week it stops
// being useful, so the date is shown instead.
export function formatRelative(value: string, now = Date.now()): string {
  const diff = new Date(value).getTime() - now;
  const size = Math.abs(diff);
  if (size < 60_000) {
    return 'now';
  }
  if (size >= 7 * 86_400_000) {
    return dateTime.format(new Date(value));
  }
  const [unit, ms] =
    UNITS.find(([, ms]) => size >= ms) ?? (['minute', 60_000] as const);
  return relative.format(Math.trunc(diff / ms), unit);
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
