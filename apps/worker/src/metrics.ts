import { Counter, Gauge, Histogram, type Registry } from '@hookline/shared';

// Labels only take values from small, fixed sets. A label per endpoint or
// project would turn every customer into new series in Prometheus; that
// detail stays in the database and in traces.

export type AttemptOutcome =
  'succeeded' | 'retry' | 'dead' | 'endpoint_disabled';

export function createDeliveryMetrics(
  registry: Registry,
  inFlight: () => number,
) {
  const registers = [registry];
  return {
    attempts: new Counter({
      name: 'hookline_delivery_attempts_total',
      help: 'Delivery attempts recorded, by what the attempt led to.',
      labelNames: ['outcome'] as const,
      registers,
    }),
    attemptDuration: new Histogram({
      name: 'hookline_delivery_attempt_duration_seconds',
      help: 'Time from sending a webhook to its response or error.',
      labelNames: ['outcome'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    }),
    // Attempts that got no HTTP response, by Node's error code, such as
    // ECONNREFUSED, TimeoutError or SSRF_BLOCKED.
    attemptErrors: new Counter({
      name: 'hookline_delivery_attempt_errors_total',
      help: 'Attempts that got no HTTP response, by error code.',
      labelNames: ['code'] as const,
      registers,
    }),
    // The delivery SLO: the first attempt should start within 5 seconds of
    // the event being accepted.
    firstAttemptDelay: new Histogram({
      name: 'hookline_delivery_first_attempt_delay_seconds',
      help: 'Time from accepting an event to starting its first attempt.',
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
      registers,
    }),
    deferrals: new Counter({
      name: 'hookline_delivery_deferrals_total',
      help: 'Messages put back to wait without spending an attempt.',
      labelNames: ['reason'] as const,
      registers,
    }),
    duplicates: new Counter({
      name: 'hookline_delivery_duplicates_total',
      help: 'Messages dropped because their attempt was already recorded.',
      registers,
    }),
    abandoned: new Counter({
      name: 'hookline_delivery_abandoned_total',
      help: 'Deliveries ended because their endpoint is no longer active.',
      registers,
    }),
    processingErrors: new Counter({
      name: 'hookline_delivery_processing_errors_total',
      help: 'Internal failures, such as the database being down, that returned a message to the queue.',
      registers,
    }),
    inFlight: new Gauge({
      name: 'hookline_deliveries_in_flight',
      help: 'Messages this worker is processing now.',
      registers,
      collect() {
        this.set(inFlight());
      },
    }),
  };
}
