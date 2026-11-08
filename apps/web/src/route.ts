import type { Attempt, DeliveryStatus, EventDelivery } from './api/types';
import { formatRelative, formatTime } from './format';

// A delivery drawn as a route: one stop per attempt, and one more for the
// try that is still to come. The retry schedule lives in the worker
// (RETRY_DELAYS), so the route shows what happened and what is next, never
// a schedule the dashboard would have to guess.

export type StopKind = 'failed' | 'succeeded' | 'next' | 'held';

export interface Stop {
  kind: StopKind;
  // "First try", "1 min later", "Next try"
  label: string;
  // The HTTP status or error code, or what the next stop is waiting for.
  result: string;
  // When it happened, or when it is due.
  detail: string;
  attempt?: Attempt;
}

export interface RouteInput {
  status: DeliveryStatus;
  next_attempt_at: string | null;
  attempts: Attempt[];
}

export function isSuccess(attempt: Attempt): boolean {
  const status = attempt.response_status;
  return status !== null && status >= 200 && status < 300;
}

export function attemptResult(attempt: Attempt): string {
  if (attempt.response_status === null) {
    return attempt.error_code ?? 'No answer';
  }
  return String(attempt.response_status);
}

// "42 s", "5 min", "2 h", "2 h 5 min"
export function formatGap(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// The circuit breaker holds an endpoint's deliveries until circuitOpenUntil,
// without moving next_attempt_at, so a held delivery shows that moment
// instead of a time already past.
export function heldUntil(
  circuitOpenUntil: string | null | undefined,
  now = Date.now(),
): string | null {
  return circuitOpenUntil && Date.parse(circuitOpenUntil) > now
    ? circuitOpenUntil
    : null;
}

export function routeStops(
  delivery: RouteInput,
  held: string | null = null,
  now = Date.now(),
): Stop[] {
  const stops: Stop[] = delivery.attempts.map((attempt, index) => {
    const previous = delivery.attempts[index - 1];
    const gap = previous
      ? Date.parse(attempt.started_at) - Date.parse(previous.started_at)
      : 0;
    const duration =
      attempt.duration_ms === null
        ? ''
        : ` · ${formatDuration(attempt.duration_ms)}`;
    return {
      kind: isSuccess(attempt) ? 'succeeded' : 'failed',
      label: previous ? `${formatGap(gap)} later` : 'First try',
      result: attemptResult(attempt),
      detail: `${formatTime(attempt.started_at)}${duration}`,
      attempt,
    };
  });

  if (delivery.status === 'pending' || delivery.status === 'retrying') {
    const label = stops.length === 0 ? 'First try' : 'Next try';
    if (held) {
      stops.push({
        kind: 'held',
        label,
        result: 'Paused',
        detail: `held until ${formatTime(held)}`,
      });
    } else {
      const due = delivery.next_attempt_at;
      stops.push({
        kind: 'next',
        label,
        result: 'Waiting',
        detail:
          due && Date.parse(due) > now ? formatRelative(due, now) : 'due now',
      });
    }
  }
  return stops;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ??
        'th');
  return `${n}${suffix}`;
}

export interface Summary {
  title: string;
  text: string;
}

// One sentence for where the delivery stands and what to do about it.
export function routeSummary(
  delivery: RouteInput,
  held: string | null = null,
  now = Date.now(),
): Summary {
  const count = delivery.attempts.length;
  const last = delivery.attempts.at(-1);
  switch (delivery.status) {
    case 'succeeded':
      return {
        title: `Delivered on the ${ordinal(count)} try`,
        text:
          count > 1
            ? `The endpoint failed ${count - 1} ${count === 2 ? 'time' : 'times'} before it answered with a success.`
            : 'The endpoint answered with a success right away.',
      };
    case 'dead':
      if (last?.response_status === 410) {
        return {
          title: 'The endpoint is gone',
          text: 'It answered 410 Gone, so Hookline disabled it and stopped trying. Enable the endpoint, then retry.',
        };
      }
      return {
        title:
          count === 1 ? 'The only try failed' : `All ${count} tries failed`,
        text: 'Hookline stopped trying. Fix the endpoint, then retry: it gets one more try.',
      };
    default:
      if (held) {
        return {
          title: `Next try after ${formatTime(held)}`,
          text: 'The endpoint failed several times in a row, so Hookline is holding its deliveries. The held try does not count.',
        };
      }
      if (count === 0) {
        return {
          title: 'Waiting for the first try',
          text: 'It starts within seconds of the event being published.',
        };
      }
      return {
        title:
          delivery.next_attempt_at && Date.parse(delivery.next_attempt_at) > now
            ? `Next try ${formatRelative(delivery.next_attempt_at, now)}`
            : 'Next try is due now',
        text: `${count} ${count === 1 ? 'try' : 'tries'} failed so far. Hookline waits longer after each failure.`,
      };
  }
}

export type Pip = 'failed' | 'succeeded' | 'next';

// The route in miniature for lists, which have the attempt count but not
// the attempts themselves.
export function routePips(delivery: EventDelivery): Pip[] {
  const count = delivery.attempt_count;
  const pips: Pip[] = Array.from({ length: count }, () => 'failed');
  if (delivery.status === 'succeeded' && count > 0) {
    pips[count - 1] = 'succeeded';
  }
  if (delivery.status === 'pending' || delivery.status === 'retrying') {
    pips.push('next');
  }
  return pips;
}

export function pipsLabel(delivery: EventDelivery, now = Date.now()): string {
  const count = delivery.attempt_count;
  switch (delivery.status) {
    case 'succeeded':
      return `Delivered on the ${ordinal(count)} try`;
    case 'dead':
      return count === 1
        ? 'Gave up after 1 try'
        : `Gave up after ${count} tries`;
    default:
      if (count === 0) {
        return 'Waiting for the first try';
      }
      return delivery.next_attempt_at &&
        Date.parse(delivery.next_attempt_at) > now
        ? `Next try ${formatRelative(delivery.next_attempt_at, now)}`
        : 'Next try is due now';
  }
}
