# Hookline

Entrega confiável de webhooks: publique um evento uma vez, e o Hookline o entrega pelo menos uma vez ou o move para uma dead-letter queue, com histórico auditável de cada tentativa.

> **Status:** início do desenvolvimento. O caminho feliz funciona: um evento é entregue, assinado e registrado. O retry e as proteções necessárias para URLs de terceiros, como o bloqueio de SSRF, ainda não existem.

[Read in English](README.md)

## Requisitos

- Node.js 24 (veja `.nvmrc`)
- pnpm, via Corepack (`corepack enable`)
- Docker com Compose

## Como começar

```bash
pnpm install
pnpm infra:up
pnpm check
```

`pnpm infra:up` sobe o PostgreSQL e o RabbitMQ, acessíveis apenas pelo localhost. O painel de gerenciamento do RabbitMQ fica em <http://localhost:15672>. `pnpm check` inclui testes de integração, que precisam do Docker rodando.

## Como rodar localmente

Crie a configuração local, aplique as migrações e crie um projeto. A API key aparece uma única vez.

```bash
cp .env.example .env
pnpm db:migrate
pnpm project:create demo
```

Rode cada processo em um terminal próprio:

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

A documentação da API fica em <http://localhost:3000/docs>. Para enviar um webhook de teste, cadastre o receptor como endpoint e publique um evento, substituindo `<API_KEY>`:

```bash
curl -X POST http://localhost:3000/v1/endpoints -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:4000/hooks","event_types":["payment.approved"]}'
```

```bash
curl -X POST http://localhost:3000/v1/events -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"type":"payment.approved","payload":{"amount":4200}}'
```

Veja o que chegou em <http://localhost:4000/received> e o histórico em `GET /v1/events/:id` e `GET /v1/deliveries/:id`.

## Decisões de arquitetura

Veja [docs/adr](docs/adr).

## Licença

[MIT](LICENSE)
