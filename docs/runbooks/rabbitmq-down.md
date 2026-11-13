# RabbitMQ fora do ar

**Sem alerta próprio.** Os sinais são:

- o relay e o carteiro ficam `0/1` (o `/readyz` deles depende da conexão com o RabbitMQ);
- os logs mostram reconexões ao broker;
- `HooklineOutboxStuck` dispara em 2 a 3 minutos.

## O que significa

O RabbitMQ é a esteira. Sem ele, nada sai para entrega, mas **a API continua aceitando eventos**, porque grava só no Postgres. Tudo fica guardado na outbox, e o relay publica quando a esteira voltar.

**As mensagens que já estavam nas filas sobrevivem:** as filas são quorum, gravadas em disco. As que estavam com um carteiro sem `ack` voltam para a fila e são deduplicadas pela tentativa registrada no banco.

## Diagnóstico

```sh
kubectl -n hookline get pod rabbitmq-0
kubectl -n hookline logs rabbitmq-0
kubectl -n hookline logs rabbitmq-0 --previous
kubectl -n hookline exec rabbitmq-0 -- rabbitmq-diagnostics status
kubectl -n hookline exec rabbitmq-0 -- rabbitmq-diagnostics alarms
```

| O que aparece                  | Leitura                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| reinícios e `CrashLoopBackOff` | veja `logs --previous`; um erro de permissão no `.erlang.cookie` já aconteceu na fase 6, com o `fsGroup` deixando o arquivo legível pelo grupo |
| alarme de memória ou de disco  | o RabbitMQ bloqueia quem publica até o alarme passar                                                                                           |
| `Startup probe failed`         | a inicialização demora; ele tem até 5 minutos                                                                                                  |

## Ação

- **Reiniciando sozinho:** espere a `startupProbe` passar. O relay e o carteiro reconectam sozinhos.
- **Alarme de disco:** veja as filas maiores. A DLQ guarda mensagens por 30 dias, e uma DLQ muito grande ocupa disco:

  ```sh
  kubectl -n hookline exec rabbitmq-0 -- rabbitmqctl list_queues name messages
  ```

  Não apague a DLQ: o banco é a fonte da verdade, mas a DLQ é o registro do que morreu. Se for preciso liberar espaço, aumente o volume.

- **Volume perdido (filas apagadas):** o banco continua sabendo de cada entrega, mas as mensagens que estavam nas filas sumiram, e essas entregas ficam paradas em `pending` ou `retrying`. Liste-as:

  ```sql
  SELECT status, count(*) FROM deliveries
  WHERE status IN ('pending', 'retrying') GROUP BY 1;
  ```

  **Limitação conhecida:** ainda não há um comando que reenfileire essas entregas. Elas precisam de uma linha nova na outbox, e isso não deve ser feito com SQL à mão. Até existir esse comando, é o caso a evitar.

## Confirmação

O relay e o carteiro voltam a `1/1`, a outbox esvazia e as filas voltam a se mover no painel "Mensagens por fila".
