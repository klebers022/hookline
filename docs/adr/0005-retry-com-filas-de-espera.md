# ADR 0005: Retry por filas de espera com TTL e dead-lettering

**Status:** aceita

## Contexto

Um destino pode ficar horas fora do ar, então uma entrega com falha precisa esperar antes de tentar de novo. A espera não pode prender o worker nem se perder se um processo cair. Depois da última tentativa, a entrega precisa ficar registrada para diagnóstico e reenvio.

## Decisão

Criar uma fila de espera por atraso: `deliveries.wait.1m`, `5m`, `30m`, `2h` e `6h`. Cada fila tem um TTL e devolve as mensagens expiradas a `deliveries.ready` por dead-lettering, com a estratégia `at-least-once`. As entregas esgotadas ficam com status `dead` e vão para `deliveries.dlq`.

O worker não publica no RabbitMQ. Ele grava o resultado da tentativa e o próximo passo na outbox, na mesma transação, e o relay faz a publicação. Cada mensagem informa o número da tentativa, e o worker descarta a que já tem resultado registrado.

Erros internos, como o banco fora do ar, não gastam tentativa: a mensagem volta à fila após uma espera crescente, com `x-delivery-limit: -1`.

## Alternativas consideradas

- **Plugin de mensagens atrasadas do RabbitMQ:** dependeria de um plugin externo e guardaria as mensagens de um modo que não é replicado como as quorum queues.
- **Uma só fila de espera com TTL por mensagem:** o RabbitMQ só expira a mensagem do início da fila, então uma espera de 6 h atrasaria outra de 1 min.
- **Agendar pelo banco, consultando `next_attempt_at`:** funciona, mas move para o banco um trabalho de fila e deixa de exercitar a topologia do RabbitMQ, que é um objetivo do projeto.
- **Publicar direto do worker:** deixaria uma janela entre gravar a falha e publicar a próxima tentativa, em que uma queda poderia abandonar a entrega.

## Consequências

- Uma queda entre o commit e o `ack` gera apenas uma mensagem duplicada, que é descartada.
- Cada novo atraso cria uma fila. Mudar `RETRY_DELAYS` não conflita com as filas antigas, que continuam devolvendo o que já guardam, mas precisam ser removidas manualmente depois.
- O calendário é fixo e não tem variação aleatória, então avisos que falham juntos voltam juntos.
- O banco é a fonte da verdade. O reenvio manual usa o banco, e a mensagem antiga fica na DLQ até expirar em 30 dias, então a profundidade da DLQ pode superestimar as entregas `dead`.
- Os argumentos de uma fila existente não podem ser alterados. Uma mudança neles exige recriar a fila.
