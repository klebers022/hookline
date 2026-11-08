import { describe, expect, it } from 'vitest';
import { formatRelative } from './format';

const NOW = Date.parse('2026-11-08T19:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('formatRelative', () => {
  it('rounds under a minute either way', () => {
    expect(formatRelative(at(-59_000), NOW)).toBe('just now');
    expect(formatRelative(at(30_000), NOW)).toBe('in under a minute');
  });

  it('uses the largest whole unit, in the past and the future', () => {
    expect(formatRelative(at(-2 * 60_000), NOW)).toBe('2 minutes ago');
    expect(formatRelative(at(28 * 60_000), NOW)).toBe('in 28 minutes');
    expect(formatRelative(at(-90 * 60_000), NOW)).toBe('1 hour ago');
    expect(formatRelative(at(-26 * 3_600_000), NOW)).toBe('yesterday');
  });

  it('falls back to the date after a week', () => {
    expect(formatRelative(at(-8 * 86_400_000), NOW)).not.toMatch(/ago/);
  });
});
