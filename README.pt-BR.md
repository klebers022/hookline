# Hookline

Entrega confiável de webhooks: publique um evento uma vez, e o Hookline o entrega pelo menos uma vez ou o move para uma dead-letter queue, com histórico auditável de cada tentativa.

> **Status:** início do desenvolvimento. Os eventos são entregues, assinados, registrados e reenviados em caso de falha, e as entregas esgotadas vão para uma dead-letter queue. As proteções necessárias para URLs de terceiros, como o bloqueio de SSRF, ainda não existem.

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

## Política de entrega

Uma entrega tem até 6 tentativas: uma imediata e outras depois de 1 minuto, 5 minutos, 30 minutos, 2 horas e 6 horas. Qualquer resposta `2xx` é sucesso. Qualquer outra resposta, erro de rede ou timeout de 10 segundos agenda a próxima tentativa. Redirects não são seguidos.

- **`410 Gone`:** desativa o endpoint e encerra a entrega.
- **Endpoint desativado ou removido:** encerra a entrega quando chega a hora da próxima tentativa.
- **Entrega esgotada:** recebe o status `dead` e uma mensagem em `deliveries.dlq`.
- **Reenvio manual:** `POST /v1/deliveries/:id/retry` agenda mais uma tentativa para uma entrega `dead` cujo endpoint esteja ativo.

A entrega é "pelo menos uma vez", então um endpoint pode receber o mesmo evento mais de uma vez. Use o header `webhook-id`, que não muda entre as tentativas, para descartar repetições.

`RETRY_DELAYS` muda o calendário, por exemplo `2s,2s,2s,2s,2s` para um teste local rápido.

## Decisões de arquitetura

Veja [docs/adr](docs/adr).

## Licença

[MIT](LICENSE)
