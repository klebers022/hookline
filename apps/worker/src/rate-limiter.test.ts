import { describe, expect, it } from 'vitest';
import { TokenBuckets } from './rate-limiter.js';

function clock() {
  let now = 0;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('TokenBuckets', () => {
  it('allows a burst and then refuses', () => {
    const time = clock();
    const buckets = new TokenBuckets(2, 2, time.now);

    expect(buckets.tryTake('a')).toBe(true);
    expect(buckets.tryTake('a')).toBe(true);
    expect(buckets.tryTake('a')).toBe(false);
  });

  it('refills at the configured rate', () => {
    const time = clock();
    const buckets = new TokenBuckets(2, 2, time.now);
    buckets.tryTake('a');
    buckets.tryTake('a');

    time.advance(499);
    expect(buckets.tryTake('a')).toBe(false);
    time.advance(1);
    expect(buckets.tryTake('a')).toBe(true);
    expect(buckets.tryTake('a')).toBe(false);
  });

  it('never stores more than the burst', () => {
    const time = clock();
    const buckets = new TokenBuckets(10, 3, time.now);
    buckets.tryTake('a');

    time.advance(60_000);
    const taken = Array.from({ length: 5 }, () => buckets.tryTake('a'));

    expect(taken).toEqual([true, true, true, false, false]);
  });

  it('keeps each key separate', () => {
    const time = clock();
    const buckets = new TokenBuckets(1, 1, time.now);

    expect(buckets.tryTake('a')).toBe(true);
    expect(buckets.tryTake('a')).toBe(false);
    expect(buckets.tryTake('b')).toBe(true);
  });

  it('forgets idle buckets when tracking too many keys', () => {
    const time = clock();
    const buckets = new TokenBuckets(1, 1, time.now);
    for (let i = 0; i < 10_000; i += 1) {
      buckets.tryTake(`key-${i}`);
    }
    expect(buckets.size).toBe(10_000);

    time.advance(1_000);
    buckets.tryTake('new-key');

    expect(buckets.size).toBe(1);
  });
});
