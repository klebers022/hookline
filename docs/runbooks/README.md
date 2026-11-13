# Runbooks

O que fazer quando algo dá errado no Hookline. Cada alerta do Prometheus aponta para o seu runbook (`runbook_url`).

| Runbook                                          | Quando usar                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| [Outbox parada](outbox-stuck.md)                 | alerta `HooklineOutboxStuck`                                         |
| [Entregas na DLQ](dead-letters.md)               | alerta `HooklineDeadLetters`                                         |
| [1ª tentativa lenta](first-attempt-slow.md)      | alerta `HooklineFirstAttemptSlow`                                    |
| [Muitas falhas de entrega](high-failure-rate.md) | alerta `HooklineHighFailureRate`                                     |
| [Processo fora do ar](process-down.md)           | alerta `HooklineProcessDown`                                         |
| [Postgres fora do ar](postgres-down.md)          | a API responde erro, e os logs mostram falhas de conexão com o banco |
| [RabbitMQ fora do ar](rabbitmq-down.md)          | o relay e o carteiro ficam "não prontos", e a outbox para            |
| [Voltar uma versão](rollback.md)                 | uma versão nova piorou algo                                          |

## Antes de começar

Os comandos valem para o cluster (k3d ou k3s), no namespace `hookline`. No Docker Compose, troque `kubectl -n hookline exec <pod> --` por `docker compose exec <serviço>`.

**Atalhos usados nos runbooks:**

```sh
# SQL no banco
kubectl -n hookline exec postgres-0 -- psql -U hookline -d hookline -c "<consulta>"

# Filas do RabbitMQ: prontas e sem ack
kubectl -n hookline exec rabbitmq-0 -- rabbitmqctl list_queues name messages_ready messages_unacknowledged

# Logs de um processo
kubectl -n hookline logs deploy/relay --since=15m

# Prometheus, para consultas que o painel não mostra
kubectl -n observability port-forward svc/prometheus 19090:9090
```

O painel "Hookline – visão geral" fica em `http://grafana.hookline.localhost:8088`, e os logs de aviso e erro estão na última linha dele.

## Como o Hookline falha

Vale lembrar o que é seguro antes de agir:

- **Um evento aceito (`202`) já está no banco**, junto com as entregas e a outbox, na mesma transação. Nenhuma queda de processo o perde.
- **Reiniciar o relay, o carteiro ou a API é sempre seguro.** O relay republica o que não marcou como publicado. O carteiro descarta uma mensagem cuja tentativa já está registrada.
- **Duplicatas são permitidas** (entrega "pelo menos uma vez", ADR 4). O destino deduplica pelo `webhook-id`.
- **Nunca apague linhas da outbox nem mensagens das filas à mão.** O banco é a fonte da verdade, e a DLQ é só um registro (ADR 5).
