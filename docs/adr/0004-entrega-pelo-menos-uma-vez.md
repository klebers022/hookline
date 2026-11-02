# ADR 0004: Entrega "pelo menos uma vez"

**Status:** aceita

## Contexto

Entregar exatamente uma vez não é possível por HTTP: se a resposta do destino se perde, o Hookline não sabe se o webhook foi processado. Só resta escolher entre o risco de perder um evento e o risco de repeti-lo.

## Decisão

Garantir a entrega "pelo menos uma vez". O worker só confirma a mensagem no RabbitMQ depois de gravar o resultado no PostgreSQL. O header `webhook-id` é estável para o mesmo evento, permitindo que o destino descarte repetições.

## Consequências

- Uma falha entre o envio e a confirmação gera um reenvio, em vez de uma perda.
- O worker descarta mensagens duplicadas de entregas já finalizadas, mas não elimina toda repetição: o destino ainda precisa ser idempotente.
- Isso deve estar documentado para quem integra, porque a deduplicação no destino faz parte do contrato.
