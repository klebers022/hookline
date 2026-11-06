# Hookline

Reliable webhook delivery: publish an event once, and Hookline delivers it at least once or moves it to a dead-letter queue, with an auditable history of every attempt.

> **Status:** early development. Events are delivered, signed, recorded, and retried, and exhausted deliveries go to a dead-letter queue. Endpoint URLs are protected against SSRF, a failing or overloaded endpoint does not hold back the others, and processes shut down without cutting deliveries short. Container images, observability, and a dashboard come next.

[Leia em português](README.pt-BR.md)

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm, through Corepack (`corepack enable`)
- Docker with Compose

## Getting started

```bash
pnpm install
pnpm infra:up
pnpm check
```

`pnpm infra:up` starts PostgreSQL and RabbitMQ, bound to localhost only. The RabbitMQ management UI is at <http://localhost:15672>. `pnpm check` includes integration tests, which need Docker running.

## Running locally

Create your local configuration, apply the migrations, and create a project. The API key is shown only once.

```bash
cp .env.example .env
pnpm db:migrate
pnpm project:create demo
```

Run each process in its own terminal:

```bash
pnpm dev:api
```

```bash
pnpm dev:relay
```

```bash
pnpm dev:deliver
```

```bash
pnpm dev:receiver
```

The API documentation is at <http://localhost:3000/docs>. To send a test webhook, register the test receiver as an endpoint and publish an event, replacing `<API_KEY>`:

```bash
curl -X POST http://localhost:3000/v1/endpoints -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:4000/hooks","event_types":["payment.approved"]}'
```

```bash
curl -X POST http://localhost:3000/v1/events -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"type":"payment.approved","payload":{"amount":4200}}'
```

See what arrived at <http://localhost:4000/received>, and the history at `GET /v1/events/:id` and `GET /v1/deliveries/:id`.

## Delivery policy

A delivery gets up to 6 attempts: one right away, then after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours. Any `2xx` response is a success. Any other response, a network error, or a 10-second timeout schedules the next attempt. Redirects are not followed.

- **`410 Gone`:** disables the endpoint and ends the delivery.
- **Disabled or deleted endpoint:** ends the delivery when its next attempt comes up.
- **Exhausted delivery:** gets the `dead` status and a message in `deliveries.dlq`.
- **Manual retry:** `POST /v1/deliveries/:id/retry` queues one more attempt for a `dead` delivery whose endpoint is active.

Delivery is at least once, so an endpoint can receive the same event more than once. Use the `webhook-id` header, which stays the same across attempts, to discard repeats.

`RETRY_DELAYS` changes the schedule, for example `2s,2s,2s,2s,2s` for a quick local test.

### Endpoint isolation

- **Circuit breaker:** after 5 failures in a row, Hookline stops calling the endpoint for 5 minutes. Deliveries wait without spending attempts. The endpoint's `consecutive_failures` and `circuit_open_until` show its state. A success, activating the endpoint again, or changing its URL closes the circuit.
- **Rate limit:** each worker sends at most 50 webhooks per second to each endpoint, set with `ENDPOINT_RATE_LIMIT_PER_SECOND`. Deliveries over the limit wait one second, without spending attempts.

## Publishing safely

- **Repeated requests:** send an `Idempotency-Key` header on `POST /v1/events` to retry a request safely. The same key and content return the original event with `idempotent-replayed: true`. The same key with different content returns `409`.
- **Rate limit:** each project can make 6,000 API requests per minute by default, set with `RATE_LIMIT_PER_MINUTE`. The count is per API process. Past the limit, the API returns `429` with a `retry-after` header.
- **Secret rotation:** `POST /v1/endpoints/:id/rotate-secret` returns a new secret, shown only once. For 24 hours, webhooks carry signatures from both the old and the new secret, so you can switch without rejecting any. Rotating again within that period ends the older secret at once.

## Endpoint URL protection

Hookline calls URLs chosen by its clients, so it blocks requests to internal addresses (SSRF):

- **Allowed URLs:** `https` only, without credentials.
- **Blocked addresses:** private networks, loopback, link-local (including the cloud metadata address `169.254.169.254`), and other reserved ranges, in IPv4 and IPv6.
- **At registration:** the API resolves the hostname and rejects the URL if any address is blocked.
- **On every connection:** the worker checks again and connects to the address it checked, so a DNS answer that changes later cannot reach an internal address. A blocked attempt is recorded with the `SSRF_BLOCKED` error.

`ALLOW_PRIVATE_TARGETS=true` turns this off, so local development can use the test receiver at `http://127.0.0.1`. It is off unless set, and must stay off wherever third parties can register endpoints.

## Shutdown

On `SIGINT` or `SIGTERM`, each process finishes its work in progress before exiting:

- **API:** stops accepting connections and answers the requests in progress.
- **Relay:** finishes the batch it is publishing.
- **Delivery worker:** stops taking messages and waits up to 15 seconds for the deliveries in progress. Messages still running at that point return to the queue, and the duplicate check keeps a recorded attempt from repeating.

A second signal, or 30 seconds without finishing, ends the process at once.

## Production build

`pnpm build` compiles every package to `dist/`, and `node apps/worker/dist/main-deliver.js` runs a process without `tsx`. Each package exports its compiled `dist/` by default and its TypeScript source under the `@hookline/source` condition, which the `dev` scripts, the type checker, and the tests use, so development needs no build.

`pnpm db:migrate` reads `db/migrations` from the repository. Set `MIGRATIONS_DIR` to read them from elsewhere.

## Running in containers

```sh
pnpm stack:up
pnpm stack:smoke
pnpm stack:down
```

`pnpm stack:up` builds the images from the `Dockerfile` and starts the whole stack: migrations, API at <http://localhost:3000>, relay, delivery worker and test receiver at <http://localhost:4000>, which endpoints reach as `http://test-receiver:4000/hooks`. It uses the same ports as the `pnpm dev:*` scripts, so run one or the other. `pnpm stack:smoke` publishes an event end to end and stops the delivery worker during a slow delivery to check that the delivery is still recorded. CI runs the same check on every pull request.

There are three images, each running as the unprivileged `node` user with `node` as process 1:

| Image                    | Command                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `hookline-api`           | `node dist/server.js` by default; also `node dist/scripts/migrate.js` and `node dist/scripts/create-project.js <name>` |
| `hookline-worker`        | `node dist/main-deliver.js` by default; `node dist/main-relay.js` for the relay                                        |
| `hookline-test-receiver` | `node dist/main.js`                                                                                                    |

Create a project in the running stack with `docker compose --profile app run --rm api node dist/scripts/create-project.js <name>`.

## Observability

```sh
pnpm stack:up
pnpm obs:up
pnpm obs:down
```

Each process serves `/metrics` (Prometheus format), `/healthz` and `/readyz` on an ops port of its own, which is never the API's public port: `METRICS_PORT`, 9464 in containers, and 9464, 9465 and 9466 for the API, the relay and the delivery worker under `pnpm dev:*`. It listens on `127.0.0.1` unless `METRICS_HOST` says otherwise.

`pnpm obs:up` starts Prometheus at <http://localhost:9090>, Tempo for traces, and Grafana at <http://localhost:3001>, which opens on the "Hookline – visão geral" dashboard. Prometheus scrapes the containers started by `pnpm stack:up` and RabbitMQ's queue metrics. The dashboard and data sources are provisioned from `infra/observability`, so edit the JSON there rather than in the UI.

| Metric                                                                           | What it shows                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `hookline_http_request_duration_seconds`                                         | API latency by method, route and status class                            |
| `hookline_events_accepted_total`, `hookline_deliveries_created_total`            | New events and the deliveries they fanned out to                         |
| `hookline_outbox_pending`, `hookline_outbox_oldest_pending_age_seconds`          | Rows waiting for the relay; a growing age means it stopped               |
| `hookline_outbox_published_total`                                                | Messages published, by kind: `ready`, `wait` or `dead`                   |
| `hookline_delivery_attempts_total`, `hookline_delivery_attempt_duration_seconds` | Attempts by outcome: `succeeded`, `retry`, `dead` or `endpoint_disabled` |
| `hookline_delivery_first_attempt_delay_seconds`                                  | Time from accepting an event to its first attempt, the delivery SLO      |
| `hookline_delivery_deferrals_total`                                              | Messages put back without spending an attempt, by reason                 |
| `hookline_endpoints_circuit_open`                                                | Endpoints with an open circuit breaker                                   |

Labels only take values from small, fixed sets. Per-endpoint detail stays in the database.

### Traces

The API, relay and delivery worker send OpenTelemetry traces over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, which the compose stack does, pointing at Tempo. Without it, tracing does not load. The images load it with `node --import @hookline/shared/tracing` before the app, which traces HTTP requests, PostgreSQL queries and the webhook POST, and adds `trace_id` and `span_id` to log lines.

A trace crosses the outbox and the queue by hand: each outbox row stores the W3C trace context of the code that wrote it (`outbox.trace_context`), the relay publishes as a child of it and sends its own context in the message headers, and the delivery worker continues from there. So one trace shows `POST /v1/events`, the database writes, the publish, the delivery attempt and the endpoint's response. A retry, which can come hours later, starts a new trace with a link to the previous attempt's. In Grafana, open Explore, pick Tempo and search, for example, `{ name = "POST /v1/events" }`.

Webhook requests carry a `traceparent` header, so an endpoint that traces can join the same trace.

## Published images

Every merge to `main` publishes the three images for `linux/amd64` and `linux/arm64`, tagged `sha-<commit>` and `main`, and a `v*` tag adds its version:

```sh
docker pull ghcr.io/klebers022/hookline-api:main
```

Before publishing, Trivy scans each image and fails on a critical or high vulnerability that has a fix. Pull requests run the same scan without publishing, and the full report is in the repository's Security tab. Dependabot keeps the base image digest, the GitHub Actions and the npm packages up to date.

## Architecture decisions

See [docs/adr](docs/adr).

## License

[MIT](LICENSE)
