const DEFAULT_RETRY_DELAYS = '1m,5m,30m,2h,6h';
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

export interface RetryDelay {
  label: string;
  ms: number;
}

export type NextStep =
  | { action: 'succeed' }
  | { action: 'retry'; delay: RetryDelay }
  | { action: 'dead' }
  | { action: 'disable_endpoint' };

export function parseRetryDelays(
  value: string = DEFAULT_RETRY_DELAYS,
): RetryDelay[] {
  return value.split(',').map((label) => {
    const match = /^([1-9]\d*)([smh])$/.exec(label);
    if (!match) {
      throw new Error(`Invalid retry delay: ${label}`);
    }
    const [, amount, unit] = match;
    return { label, ms: Number(amount) * UNIT_MS[unit as string]! };
  });
}

// One delay exists for each attempt that can still be followed by another, so
// a manual retry past the end of the schedule gets a single attempt.
export function decideNextStep(
  attemptNumber: number,
  responseStatus: number | null,
  delays: RetryDelay[],
): NextStep {
  if (
    responseStatus !== null &&
    responseStatus >= 200 &&
    responseStatus < 300
  ) {
    return { action: 'succeed' };
  }
  if (responseStatus === 410) {
    return { action: 'disable_endpoint' };
  }
  const delay = delays[attemptNumber - 1];
  return delay ? { action: 'retry', delay } : { action: 'dead' };
}
