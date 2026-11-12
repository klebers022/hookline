# ADR 0008: Isolamento por endpoint, com rate limit em memória e sem Redis

**Status:** aceita

## Contexto

Todos os clientes compartilham os mesmos workers. Um endpoint fora do ar ou lento não pode consumir tentativas à toa nem atrasar a entrega para os outros. Também é preciso evitar que o Hookline sobrecarregue um destino com uma rajada de eventos.

## Decisão

**Circuit breaker no banco.** Depois de 5 falhas seguidas, o endpoint fica com `circuit_open_until` 5 minutos no futuro. Enquanto esse prazo não vence, as mensagens dele são adiadas sem chamar o destino e sem gastar tentativa. O calendário, porém, continua correndo: uma entrega adiada depois do fim dele (a soma de `RETRY_DELAYS`, contada da criação do evento) vai para `dead`, com uma tentativa registrada como `DEADLINE_EXCEEDED` e sem chamar o destino. O reenvio manual, que fica fora do calendário, não tem prazo. Um sucesso zera a contagem. Ativar o endpoint de novo ou trocar a URL também fecha o circuito. O estado fica em `endpoints`, então vale para todos os workers.

**Rate limit em memória.** Cada worker mantém um token bucket por endpoint, de 50 envios por segundo por padrão (`ENDPOINT_RATE_LIMIT_PER_SECOND`). Sem ficha disponível, a mensagem espera em `deliveries.wait.1s`. Assim uma rajada é liberada aos poucos, em vez de prender o worker.

**Adiamento direto no RabbitMQ.** Um adiamento não muda nada no banco, então o worker publica a mensagem na fila de espera com confirmação e só depois dá o `ack`. As tentativas novas continuam passando pela outbox (ADR 0005), porque nelas o banco muda junto.

## Alternativas consideradas

- **Redis para o rate limit:** daria um limite exato entre workers, mas acrescentaria um serviço para operar e monitorar em uma VPS pequena.
- **Esperar dentro do worker:** a mensagem ocuparia uma das vagas do `prefetch`, e um endpoint lento poderia ocupar todas.
- **Circuit breaker em memória:** cada worker descobriria a falha sozinho, e um endpoint fora do ar receberia 5 tentativas a mais por worker.
- **Adiar pela outbox:** gravaria uma linha por adiamento sem necessidade, o que pesa justamente durante uma rajada.

## Consequências

- Com N workers, o limite real por endpoint é N × 50 envios por segundo. Isso é aceitável para proteger destinos, mas não serve como cota contratual.
- Quando o circuito expira, as mensagens adiadas voltam juntas, até o limite de `prefetch` de cada worker. Se a primeira falhar, o circuito abre de novo.
- Uma falha registra uma atualização na linha do endpoint. Em rajadas para o mesmo destino, essas atualizações disputam a mesma linha.
- Sem o prazo, um endpoint fora do ar de vez seguraria as entregas por semanas: os adiamentos não gastam tentativas, e só cerca de uma passa a cada abertura do circuito. Com 1.000 entregas pendentes e o circuito de 5 minutos, seriam cerca de 20 dias até a DLQ. O teste de caos da fase 8 revelou isso, e o prazo foi acrescentado depois.
- Com o prazo, uma entrega pode terminar com menos de 6 tentativas que chamaram o destino.
- Adiamentos não alteram `next_attempt_at`. Esse campo mostra só o horário das novas tentativas.
- Um adiamento pode gerar uma mensagem duplicada se o worker cair entre publicar e confirmar. A duplicata é descartada, como as demais (ADR 0004).
