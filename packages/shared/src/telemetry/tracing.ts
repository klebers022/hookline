// Starts OpenTelemetry tracing. Loaded before the app, with
// node --import @hookline/shared/tracing, so the instrumentations can patch
// http, pg and pino before the app imports them.
//
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set: tests and pnpm dev:* load
// nothing. The service name comes from OTEL_SERVICE_NAME.
import { register } from 'node:module';
import { setTracingShutdown } from './trace-context.js';

// Requests that would only add noise: health checks and Prometheus scrapes.
const IGNORED_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // Lets the instrumentations hook ES modules, not only require().
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  // Traces only. Metrics stay with Prometheus, and logs go to stdout.
  process.env.OTEL_METRICS_EXPORTER ??= 'none';
  process.env.OTEL_LOGS_EXPORTER ??= 'none';

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { UndiciInstrumentation },
    { PgInstrumentation },
    { PinoInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-undici'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-pino'),
  ]);

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          IGNORED_PATHS.has(request.url ?? ''),
      }),
      // The webhook POST. It also sends a traceparent header, so a receiver
      // that traces can join the same trace.
      new UndiciInstrumentation(),
      // Only queries inside a traced operation: the relay polls the outbox
      // several times a second, and a span per poll would bury the rest.
      new PgInstrumentation({ requireParentSpan: true }),
      // Adds trace_id and span_id to every log line written inside a span.
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  setTracingShutdown(() => sdk.shutdown());
}
