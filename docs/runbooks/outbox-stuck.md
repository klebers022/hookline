# Outbox parada

**Alerta:** `HooklineOutboxStuck` (crítico). A linha pendente mais antiga da outbox tem mais de 60 s, há 2 minutos.

## O que significa

O relay publica a outbox no RabbitMQ a cada poucas centenas de milissegundos. Uma linha esperando um minuto quer dizer que **nenhuma entrega nova está saindo**, nem as primeiras tentativas, nem as novas tentativas agendadas. Os eventos continuam sendo aceitos e guardados, então nada se perde, mas tudo atrasa.

Na analogia dos Correios: o balcão continua recebendo cartas, mas a triagem parou de colocá-las na esteira.

## Diagnóstico

1. **O relay está rodando e pronto?**

   ```sh
   kubectl -n hookline get pods -l app.kubernetes.io/name=relay
   kubectl -n hookline logs deploy/relay --since=15m
   ```

   - Pod em `CrashLoopBackOff` ou com reinícios: veja o motivo nos logs (`--previous` mostra o contêiner anterior).
   - Pod `0/1` (não pronto): o relay não está conectado ao RabbitMQ. Vá para [RabbitMQ fora do ar](rabbitmq-down.md).

2. **O relay alcança o Postgres?** Erros como `Database connection lost` ou `ECONNREFUSED` nos logs indicam o banco. Vá para [Postgres fora do ar](postgres-down.md).

3. **Quanto está pendente?**

   ```sql
   SELECT count(*), min(created_at) FROM outbox WHERE published_at IS NULL;
   ```

4. **O RabbitMQ está recusando publicações?** As filas quorum usam `x-overflow: reject-publish`. Num disco cheio ou com um alarme de memória, o RabbitMQ bloqueia quem publica:

   ```sh
   kubectl -n hookline exec rabbitmq-0 -- rabbitmq-diagnostics alarms
   ```

## Ação

- **Relay travado, sem erro claro:** reinicie. É seguro, porque ele republica o que não marcou como publicado.

  ```sh
  kubectl -n hookline rollout restart deploy/relay
  ```

- **RabbitMQ ou Postgres fora:** siga o runbook deles. O relay volta sozinho quando eles voltam.
- **Alarme de disco ou memória no RabbitMQ:** veja o tamanho das filas. Uma DLQ enorme ocupa espaço até o TTL de 30 dias.

## Confirmação

O painel "Outbox: linha mais antiga" volta a perto de zero, e a contagem de pendentes cai. Espere um pico de entregas logo depois: é o atraso sendo esvaziado.
