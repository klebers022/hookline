import { describe, expect, it } from 'vitest';
import { requireEnv } from './env.js';

describe('requireEnv', () => {
  it('returns the value when the variable is set', () => {
    expect(requireEnv('DATABASE_URL', { DATABASE_URL: 'postgres://db' })).toBe(
      'postgres://db',
    );
  });

  it('throws when the variable is missing', () => {
    expect(() => requireEnv('DATABASE_URL', {})).toThrow('DATABASE_URL');
  });

  it('throws when the variable is empty', () => {
    expect(() => requireEnv('DATABASE_URL', { DATABASE_URL: '' })).toThrow(
      'DATABASE_URL',
    );
  });
});
