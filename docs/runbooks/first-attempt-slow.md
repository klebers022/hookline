# 1ª tentativa lenta

**Alerta:** `HooklineFirstAttemptSlow` (aviso). O p99 do atraso entre o evento aceito e a primeira tentativa passou de 5 s por 5 minutos. É o SLO de entrega.

## O que significa

Os eventos estão chegando aos destinos mais tarde do que o prometido. Nada se perdeu, mas há uma fila crescendo em algum ponto do caminho: livro → triagem → esteira → carteiro.

## Diagnóstico

Siga o caminho do evento e ache onde ele espera:

1. **Na outbox (a triagem não acompanha):** o painel "Outbox: linha mais antiga" sobe. Se passar de 60 s, é o caso de [Outbox parada](outbox-stuck.md).

2. **Na fila `deliveries.ready` (o carteiro não acompanha):**

   ```sh
   kubectl -n hookline exec rabbitmq-0 -- rabbitmqctl list_queues name messages_ready messages_unacknowledged
   ```

   Muitas mensagens prontas em `deliveries.ready` indicam que os carteiros estão ocupados.

3. **Por que o carteiro está lento:** no painel "Duração da tentativa", destinos lentos (perto do limite de 10 s) prendem o carteiro, que atende 10 mensagens por vez (`prefetch`). O painel "Adiamentos e descartes" mostra o limite de envio por destino segurando mensagens.

4. **Os recursos do carteiro:**

   ```sh
   kubectl -n hookline top pods
   ```

## Ação

- **Pico de carga legítimo:** aumente as réplicas do carteiro. Com o Argo CD, isso entra por PR no overlay; sem ele, para testar:

  ```sh
  kubectl -n hookline scale deploy/deliver --replicas=2
  ```

  Lembre que o limite de envio por destino é por réplica (ADR 8): com 2 réplicas, um destino pode receber o dobro.

- **Um destino lento prendendo todos:** o disjuntor só abre com falhas, não com lentidão. Avise o cliente e, se for preciso, pause o endpoint dele (`PATCH /v1/endpoints/:id` com `"status": "disabled"`).
- **Outbox ou RabbitMQ:** siga o runbook correspondente.

## Confirmação

O painel "Atraso até a 1ª tentativa" volta para baixo de 5 s, e a `deliveries.ready` esvazia. O alerta precisa de 5 minutos de janela para se resolver.
