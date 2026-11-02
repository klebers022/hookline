# ADR 0002: RabbitMQ em vez de Kafka

**Status:** aceita

## Contexto

Cada entrega é uma tarefa independente: um worker tenta, confirma ou agenda uma nova tentativa. Um destino com problema não pode atrasar os demais, e as novas tentativas precisam de atrasos que vão de minutos a horas. O sistema também precisa caber em uma única VPS gratuita.

## Decisão

Usar RabbitMQ, com quorum queues, confirmação manual e filas de espera.

## Consequências

- O `ack` é individual por mensagem, então uma entrega lenta ou com falha não bloqueia as seguintes.
- TTL e dead-lettering, recursos nativos do broker, permitem os atrasos de retry sem um agendador externo.
- O consumo de recursos é adequado a um único nó.
- Perdemos o replay de um log de eventos, como no Kafka. O PostgreSQL continua sendo a fonte da verdade, e o reenvio é feito a partir dele.
- O Kafka seria mais indicado se vários consumidores precisassem reler o mesmo fluxo, o que não é o caso desta versão.
