# ADR 0003: Outbox transacional

**Status:** aceita

## Contexto

Ao aceitar um evento, a API precisa gravá-lo no PostgreSQL e avisar o RabbitMQ. Não existe transação que englobe os dois sistemas: se o processo cair entre as operações, o evento pode ficar salvo sem nunca ser entregue, ou a mensagem pode apontar para um dado que não existe.

## Decisão

A API grava o evento, as entregas e as linhas da tabela `outbox` em uma única transação do PostgreSQL. Um processo separado, o relay, lê as linhas pendentes, publica com publisher confirms e só então as marca como publicadas.

## Consequências

- Um evento aceito nunca fica sem registro de envio, mesmo com o broker fora do ar.
- O relay pode cair entre publicar e marcar a linha, gerando uma mensagem duplicada. Por isso, o worker precisa tolerar duplicatas, e a garantia é "pelo menos uma vez".
- Há um novo processo para operar, e a idade da linha pendente mais antiga passa a ser uma métrica essencial.
- O polling adiciona latência e carga no banco, controladas com um índice parcial sobre as linhas pendentes e `FOR UPDATE SKIP LOCKED`, que também permite réplicas do relay.
