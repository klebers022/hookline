# Hookline

Reliable webhook delivery: publish an event once, and Hookline delivers it at least once or moves it to a dead-letter queue, with an auditable history of every attempt.

> **Status:** early development. Only the project foundation exists so far.

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

`pnpm infra:up` starts PostgreSQL and RabbitMQ, bound to localhost only. The RabbitMQ management UI is at <http://localhost:15672>. Optional overrides are documented in `.env.example`.

## Architecture decisions

See [docs/adr](docs/adr).

## License

[MIT](LICENSE)
