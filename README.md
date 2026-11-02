# Hookline

Reliable webhook delivery: publish an event once, and Hookline delivers it at least once or moves it to a dead-letter queue, with an auditable history of every attempt.

> **Status:** early development. Events are delivered, signed, recorded, and retried, and exhausted deliveries go to a dead-letter queue. The protections required for third-party URLs, such as SSRF blocking, are not implemented yet.

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

## Architecture decisions

See [docs/adr](docs/adr).

## License

[MIT](LICENSE)
