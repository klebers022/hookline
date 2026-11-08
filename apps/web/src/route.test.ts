import { describe, expect, it } from 'vitest';
import type { Attempt, EventDelivery } from './api/types';
import {
  formatGap,
  heldUntil,
  pipsLabel,
  routePips,
  routeStops,
  routeSummary,
} from './route';

const NOW = Date.parse('2026-11-08T19:10:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function attempt(
  attempt_number: number,
  minutes: number,
  response_status: number | null,
  error_code: string | null = null,
): Attempt {
  return {
    attempt_number,
    started_at: at(minutes),
    duration_ms: 42,
    response_status,
    error_code,
    response_snippet: null,
  };
}

function delivery(overrides: Partial<EventDelivery>): EventDelivery {
  return {
    id: 'd1',
    endpoint_id: 'e1',
    endpoint_url: 'https://example.com/hooks',
    status: 'retrying',
    attempt_count: 0,
    next_attempt_at: null,
    delivered_at: null,
    created_at: at(-10),
    ...overrides,
  };
}

describe('formatGap', () => {
  it('uses seconds, minutes, then hours', () => {
    expect(formatGap(42_000)).toBe('42 s');
    expect(formatGap(5 * 60_000)).toBe('5 min');
    expect(formatGap(2 * 3_600_000)).toBe('2 h');
    expect(formatGap(125 * 60_000)).toBe('2 h 5 min');
  });
});

describe('routeStops', () => {
  it('draws one stop per attempt with the gap since the one before', () => {
    const stops = routeStops({
      status: 'succeeded',
      next_attempt_at: null,
      attempts: [attempt(1, -6, 500), attempt(2, -5, 503), attempt(3, 0, 200)],
    });
    expect(stops.map((s) => [s.kind, s.label, s.result])).toEqual([
      ['failed', 'First try', '500'],
      ['failed', '1 min later', '503'],
      ['succeeded', '5 min later', '200'],
    ]);
  });

  it('names the error when there was no HTTP answer', () => {
    const [stop] = routeStops({
      status: 'dead',
      next_attempt_at: null,
      attempts: [attempt(1, -1, null, 'TIMEOUT')],
    });
    expect(stop?.result).toBe('TIMEOUT');
  });

  it('adds the next try while the delivery is still going', () => {
    const stops = routeStops(
      {
        status: 'retrying',
        next_attempt_at: at(28),
        attempts: [attempt(1, -1, 500)],
      },
      null,
      NOW,
    );
    expect(stops.at(-1)).toMatchObject({
      kind: 'next',
      label: 'Next try',
      detail: 'in 28 minutes',
    });
  });

  it('says a try is due rather than showing a time already past', () => {
    const stops = routeStops(
      {
        status: 'retrying',
        next_attempt_at: at(-3),
        attempts: [attempt(1, -4, 500)],
      },
      null,
      NOW,
    );
    expect(stops.at(-1)?.detail).toBe('due now');
  });

  it('shows a held try while the circuit is open', () => {
    const stops = routeStops(
      {
        status: 'retrying',
        next_attempt_at: at(-3),
        attempts: [attempt(1, -4, 500)],
      },
      at(4),
      NOW,
    );
    expect(stops.at(-1)).toMatchObject({ kind: 'held', result: 'Paused' });
    expect(stops.at(-1)?.detail).toMatch(/^held until /);
  });

  it('ends at the last attempt once the delivery is final', () => {
    const stops = routeStops({
      status: 'dead',
      next_attempt_at: null,
      attempts: [attempt(1, -2, 500), attempt(2, -1, 500)],
    });
    expect(stops).toHaveLength(2);
  });
});

describe('heldUntil', () => {
  it('is the circuit time only while it is ahead', () => {
    expect(heldUntil(at(4), NOW)).toBe(at(4));
    expect(heldUntil(at(-1), NOW)).toBeNull();
    expect(heldUntil(null, NOW)).toBeNull();
  });
});

describe('routeSummary', () => {
  it('counts the tries a success took', () => {
    expect(
      routeSummary({
        status: 'succeeded',
        next_attempt_at: null,
        attempts: [attempt(1, -2, 500), attempt(2, -1, 200)],
      }).title,
    ).toBe('Delivered on the 2nd try');
  });

  it('tells how to recover a dead delivery', () => {
    const summary = routeSummary({
      status: 'dead',
      next_attempt_at: null,
      attempts: [attempt(1, -2, 500), attempt(2, -1, 500)],
    });
    expect(summary.title).toBe('All 2 tries failed');
    expect(summary.text).toMatch(/then retry/);
  });

  it('explains a 410 Gone', () => {
    expect(
      routeSummary({
        status: 'dead',
        next_attempt_at: null,
        attempts: [attempt(1, -1, 410)],
      }).title,
    ).toBe('The endpoint is gone');
  });

  it('gives the held time while the circuit is open', () => {
    expect(
      routeSummary(
        {
          status: 'retrying',
          next_attempt_at: at(-3),
          attempts: [attempt(1, -4, 500)],
        },
        at(4),
        NOW,
      ).title,
    ).toMatch(/^Next try after /);
  });
});

describe('routePips', () => {
  it('marks failures, the success and the try to come', () => {
    expect(
      routePips(delivery({ status: 'succeeded', attempt_count: 3 })),
    ).toEqual(['failed', 'failed', 'succeeded']);
    expect(
      routePips(delivery({ status: 'retrying', attempt_count: 2 })),
    ).toEqual(['failed', 'failed', 'next']);
    expect(
      routePips(delivery({ status: 'pending', attempt_count: 0 })),
    ).toEqual(['next']);
  });

  it('describes them in words', () => {
    expect(pipsLabel(delivery({ status: 'succeeded', attempt_count: 1 }))).toBe(
      'Delivered on the 1st try',
    );
    expect(pipsLabel(delivery({ status: 'dead', attempt_count: 6 }))).toBe(
      'Gave up after 6 tries',
    );
    expect(
      pipsLabel(
        delivery({
          status: 'retrying',
          attempt_count: 3,
          next_attempt_at: at(28),
        }),
        NOW,
      ),
    ).toBe('Next try in 28 minutes');
  });
});
