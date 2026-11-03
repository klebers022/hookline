# Hookline

Entrega confiável de webhooks: publique um evento uma vez, e o Hookline o entrega pelo menos uma vez ou o move para uma dead-letter queue, com histórico auditável de cada tentativa.

> **Status:** início do desenvolvimento. Os eventos são entregues, assinados, registrados e reenviados em caso de falha, e as entregas esgotadas vão para uma dead-letter queue. As URLs dos endpoints são protegidas contra SSRF, um endpoint com falha ou sobrecarga não atrasa os outros, e os processos encerram sem interromper entregas. Imagens de contêiner, observabilidade e um painel vêm a seguir.

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

### Isolamento entre endpoints

- **Circuit breaker:** depois de 5 falhas seguidas, o Hookline deixa de chamar o endpoint por 5 minutos. As entregas esperam sem gastar tentativas. Os campos `consecutive_failures` e `circuit_open_until` do endpoint mostram o estado. Um sucesso, a reativação do endpoint ou a troca da URL fecham o circuito.
- **Limite de envios:** cada worker envia no máximo 50 webhooks por segundo a cada endpoint, valor definido em `ENDPOINT_RATE_LIMIT_PER_SECOND`. As entregas acima do limite esperam um segundo, sem gastar tentativas.

## Publicação segura

- **Pedidos repetidos:** envie o header `Idempotency-Key` em `POST /v1/events` para repetir um pedido com segurança. A mesma chave com o mesmo conteúdo devolve o evento original com `idempotent-replayed: true`. A mesma chave com conteúdo diferente devolve `409`.
- **Limite de pedidos:** cada projeto pode fazer 6.000 pedidos por minuto à API por padrão, valor definido em `RATE_LIMIT_PER_MINUTE`. A contagem é por processo da API. Acima do limite, a API devolve `429` com o header `retry-after`.
- **Troca de segredo:** `POST /v1/endpoints/:id/rotate-secret` devolve um novo segredo, mostrado uma única vez. Durante 24 horas, os webhooks levam as assinaturas do segredo antigo e do novo, para você trocar sem rejeitar nenhum. Uma nova troca nesse período encerra o segredo mais antigo na hora.

## Proteção das URLs dos endpoints

O Hookline chama URLs escolhidas pelos clientes, então bloqueia pedidos para endereços internos (SSRF):

- **URLs aceitas:** apenas `https`, sem usuário e senha.
- **Endereços bloqueados:** redes privadas, loopback, link-local (incluindo o endereço de metadados da nuvem, `169.254.169.254`) e outras faixas reservadas, em IPv4 e IPv6.
- **No cadastro:** a API resolve o hostname e recusa a URL se algum endereço for bloqueado.
- **Em cada conexão:** o worker confere de novo e se conecta ao endereço que conferiu, então uma resposta de DNS que mude depois não alcança um endereço interno. Uma tentativa bloqueada fica registrada com o erro `SSRF_BLOCKED`.

`ALLOW_PRIVATE_TARGETS=true` desliga essa proteção, para o desenvolvimento local usar o receptor de teste em `http://127.0.0.1`. Ela fica desligada se não for definida e deve continuar assim onde terceiros podem cadastrar endpoints.

## Encerramento

Ao receber `SIGINT` ou `SIGTERM`, cada processo termina o trabalho em andamento antes de sair:

- **API:** deixa de aceitar conexões e responde os pedidos em andamento.
- **Relay:** termina o lote que está publicando.
- **Worker de entrega:** deixa de pegar mensagens e espera até 15 segundos pelas entregas em andamento. As mensagens que ainda estiverem em execução voltam para a fila, e a checagem de duplicatas impede que uma tentativa já registrada se repita.

Um segundo sinal, ou 30 segundos sem terminar, encerra o processo na hora.

## Build de produção

`pnpm build` compila cada pacote para `dist/`, e `node apps/worker/dist/main-deliver.js` roda um processo sem `tsx`. Cada pacote exporta por padrão o `dist/` compilado e, sob a condição `@hookline/source`, o código TypeScript, usado pelos scripts `dev`, pela checagem de tipos e pelos testes. Assim, o desenvolvimento não precisa de build.

`pnpm db:migrate` lê `db/migrations` do repositório. Defina `MIGRATIONS_DIR` para ler de outra pasta.

## Decisões de arquitetura

Veja [docs/adr](docs/adr).

## Licença

[MIT](LICENSE)
