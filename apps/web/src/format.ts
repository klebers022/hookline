const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
});

export function formatDate(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : '—';
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
