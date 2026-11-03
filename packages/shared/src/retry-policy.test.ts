import { describe, expect, it } from 'vitest';
import { decideNextStep, parseRetryDelays, pickDelay } from './retry-policy.js';

const delays = parseRetryDelays();

describe('parseRetryDelays', () => {
  it('defaults to the production schedule', () => {
    expect(delays.map((delay) => delay.label)).toEqual([
      '1m',
      '5m',
      '30m',
      '2h',
      '6h',
    ]);
    expect(delays[0]?.ms).toBe(60_000);
    expect(delays[4]?.ms).toBe(21_600_000);
  });

  it('accepts a custom schedule', () => {
    expect(parseRetryDelays('2s')).toEqual([{ label: '2s', ms: 2_000 }]);
  });

  it.each(['', '5', '0s', '1d', '1m,', '-1m'])('rejects "%s"', (value) => {
    expect(() => parseRetryDelays(value)).toThrow('Invalid retry delay');
  });
});

describe('decideNextStep', () => {
  it.each([200, 204, 299])('treats %i as a success', (status) => {
    expect(decideNextStep(1, status, delays)).toEqual({ action: 'succeed' });
  });

  it.each([301, 400, 404, 500, 503, null])('retries after %s', (status) => {
    expect(decideNextStep(1, status, delays)).toMatchObject({
      action: 'retry',
      delay: { label: '1m' },
    });
  });

  it('follows the schedule for each attempt', () => {
    const labels = [1, 2, 3, 4, 5].map((attempt) => {
      const step = decideNextStep(attempt, 500, delays);
      return step.action === 'retry' ? step.delay.label : step.action;
    });

    expect(labels).toEqual(['1m', '5m', '30m', '2h', '6h']);
  });

  it('gives up after the sixth attempt', () => {
    expect(decideNextStep(6, 500, delays)).toEqual({ action: 'dead' });
  });

  it('gives up after a manual retry past the end of the schedule', () => {
    expect(decideNextStep(7, null, delays)).toEqual({ action: 'dead' });
  });

  it('disables the endpoint on 410 Gone, whatever the attempt', () => {
    expect(decideNextStep(1, 410, delays)).toEqual({
      action: 'disable_endpoint',
    });
  });
});

describe('pickDelay', () => {
  it('picks the shortest delay that covers the wait', () => {
    expect(pickDelay(delays, 90_000).label).toBe('5m');
    expect(pickDelay(delays, 60_000).label).toBe('1m');
    expect(pickDelay(delays, 0).label).toBe('1m');
  });

  it('falls back to the longest delay', () => {
    expect(pickDelay(delays, 86_400_000).label).toBe('6h');
  });

  it('does not depend on the order of the schedule', () => {
    expect(pickDelay(parseRetryDelays('5m,1s,1m'), 2_000).label).toBe('1m');
  });
});
