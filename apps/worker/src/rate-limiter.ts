const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

// One token bucket per key, kept in this process's memory. Several workers
// each keep their own buckets, so the effective limit grows with them.
export class TokenBuckets {
  readonly #buckets = new Map<string, Bucket>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = ratePerSecond,
    private readonly now: () => number = () => performance.now(),
  ) {}

  tryTake(key: string): boolean {
    const now = this.now();
    const bucket = this.#refill(key, now);
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  #refill(key: string, now: number): Bucket {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= MAX_TRACKED_KEYS) {
        this.#forgetFullBuckets(now);
      }
      bucket = { tokens: this.burst, updatedAt: now };
      this.#buckets.set(key, bucket);
      return bucket;
    }
    const elapsedSeconds = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + elapsedSeconds * this.ratePerSecond,
    );
    bucket.updatedAt = now;
    return bucket;
  }

  // A full bucket holds no state worth keeping: a new one starts full too.
  #forgetFullBuckets(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      const elapsedSeconds = (now - bucket.updatedAt) / 1000;
      if (bucket.tokens + elapsedSeconds * this.ratePerSecond >= this.burst) {
        this.#buckets.delete(key);
      }
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}
