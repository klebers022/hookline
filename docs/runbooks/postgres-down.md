# Postgres fora do ar

**Sem alerta próprio:** o Postgres não exporta métricas nesta versão. Os sinais são:

- os pedidos à API recebem erro (`502` ou `503`): o `/readyz` dela consulta o banco, e o Kubernetes a tira do Service;
- os logs da API, do relay e do carteiro mostram `Database connection lost`, `ECONNREFUSED` ou `getaddrinfo EAI_AGAIN postgres`;
- em seguida, `HooklineOutboxStuck` dispara.

## O que significa

O Postgres é o livro de registros: sem ele, o balcão não aceita eventos e o carteiro não registra tentativas. **Nada que já foi aceito se perde:**

- um pedido sem resposta `202` não foi aceito, e o cliente reenvia com a mesma `Idempotency-Key`;
- o carteiro devolve a mensagem que não conseguiu registrar e tenta de novo, com espera crescente, sem limite de devoluções;
- o relay e a API sobrevivem à queda (#45) e reconectam sozinhos.

Depois de uma queda brusca, o Postgres **recupera o log de escrita (WAL)** antes de aceitar conexões. Nesse meio-tempo, ele responde "rejecting connections". A `startupProbe` dá até 5 minutos para isso, e a sonda de vida não o reinicia enquanto ele responde (#46, [postmortem](../postmortems/2026-11-12-postgres-morto-na-recuperacao.md)).

## Diagnóstico

```sh
kubectl -n hookline get pod postgres-0
kubectl -n hookline describe pod postgres-0
kubectl -n hookline logs postgres-0
kubectl -n hookline logs postgres-0 --previous
```

| O que aparece                                                                | Leitura                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `database system was not properly shut down; automatic recovery in progress` | está recuperando; espere                          |
| `Startup probe failed` por mais de 5 minutos                                 | a recuperação está demorando demais; veja o disco |
| `No space left on device`                                                    | volume cheio; veja abaixo                         |
| `OOMKilled`                                                                  | passou do limite de 512 Mi                        |
| `Pending`                                                                    | o volume (PVC) não montou                         |

**Espaço em disco:**

```sh
kubectl -n hookline exec postgres-0 -- df -h /var/lib/postgresql/data
```

## Ação

- **Recuperando:** espere. Não apague o pod: isso recomeça a recuperação do zero.
- **Disco cheio:** a retenção diária apaga a outbox publicada há mais de 7 dias e os eventos terminados há mais de 30. Rode-a agora, e aumente o volume se não for suficiente:

  ```sh
  kubectl -n hookline create job --from=cronjob/retention retention-manual
  ```

- **Dados corrompidos ou volume perdido:** veja [Restaurar o backup](restore.md).

## Confirmação

```sh
kubectl -n hookline exec postgres-0 -- pg_isready -U hookline -d hookline
```

Depois disso, as APIs voltam a ficar prontas, o relay esvazia a outbox, e as mensagens devolvidas pelo carteiro são entregues. Os clientes que receberam erro durante a queda precisam reenviar; com a `Idempotency-Key`, não há duplicata.
