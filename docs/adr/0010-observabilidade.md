# ADR 0010: Observabilidade com Prometheus, OpenTelemetry, Tempo e Loki

**Status:** aceita

## Contexto

Até a fase 3, para saber se o Hookline estava bem, era preciso ler os logs soltos de cada contêiner ou abrir o painel do RabbitMQ. Não havia números de vazão e latência, não dava para seguir um evento do `POST /v1/events` até a resposta do endpoint, e não sabíamos quanto a stack aguenta. O SLO de entrega (99% das primeiras tentativas em até 5 s) não tinha como ser medido.

Seguir um evento é mais difícil aqui que numa API comum: entre o pedido e a entrega há uma tabela (a outbox) e uma fila. Quem publica na fila é o relay, segundos depois e fora do pedido HTTP, e uma nova tentativa pode vir horas depois.

## Decisão

**Métricas com `prom-client`, coletadas pelo Prometheus.** Cada processo serve `/metrics`, `/healthz` e `/readyz` numa porta de operação própria (9464), que nunca é a porta pública da API. Os rótulos só aceitam valores de conjuntos pequenos e fixos (`outcome`, `reason`, `route`, `status_class`); nada de ID de projeto ou endpoint, que multiplicaria as séries. O RabbitMQ entra pelo plugin `rabbitmq_prometheus`, que já vem na imagem.

**Traces com OpenTelemetry, enviados ao Tempo por OTLP.** O SDK carrega antes do app (`node --import @hookline/shared/tracing`) só quando `OTEL_EXPORTER_OTLP_ENDPOINT` está definida, e instrumenta HTTP, `pg` e `undici`.

**O trace atravessa a outbox à mão.** A linha da outbox guarda o contexto W3C de quem a escreveu (`outbox.trace_context`). O relay publica como filho dele e põe o próprio contexto nos headers AMQP, e o worker continua dali. A instrumentação automática do `amqplib` fica desligada, para não haver spans duplicados. Cada nova tentativa abre um trace novo, ligado ao anterior por _span link_, em vez de estender um trace por até 8 h e 36 min.

**Logs no Loki, coletados pelo Alloy.** Os processos continuam só escrevendo JSON no stdout. O Alloy lê os logs pelo socket do Docker, rotula por `service` e `level` e guarda `trace_id` e `span_id` como metadados estruturados, não como rótulos. No Grafana, o log leva ao trace e o trace leva aos logs.

**Alertas como regras do Prometheus, com testes.** Outbox parada, entrega na DLQ, SLO da 1ª tentativa, taxa de falhas e processo fora do ar ficam em `alerts.yml`, testados pelo promtool no CI. O Alertmanager, que enviaria os avisos, fica para a fase 7.

**Tudo provisionado por arquivo**, no perfil `observability` do compose: fontes de dados, painel e regras ficam versionados em `infra/observability`.

**Carga com k6, no mesmo compose.** O k6 envia os próprios números ao Prometheus (_remote write_), e o script de carga confere no banco que toda entrega terminou.

## Alternativas consideradas

- **OpenTelemetry também para métricas, via coletor:** um padrão só, mas exige um OpenTelemetry Collector no meio, e o `prom-client` é o caminho mais direto para o Prometheus.
- **Instrumentação automática do `amqplib`:** liga quem publica a quem consome, mas aqui quem publica é o relay, fora do pedido, então o trace morreria na outbox.
- **Um trace só para todas as tentativas:** mostraria tudo junto, mas um trace de horas atrapalha a busca e a visualização, e o Tempo o fecharia antes do fim.
- **Promtail:** foi descontinuado em favor do Alloy.
- **Elasticsearch ou OpenSearch para logs:** indexam o texto inteiro, mas pedem bem mais memória que o Loki, que só indexa os rótulos, para uma stack que precisa caber numa VPS.
- **Serviço gerenciado (Grafana Cloud, Datadog):** menos coisa para operar, mas o objetivo do projeto é aprender a montar a stack, e os dados sairiam da máquina.

## Consequências

- Uma linha de log, um trace e um ponto num gráfico apontam uns para os outros: do alerta ao gráfico, do gráfico ao trace, do trace ao log.
- O SLO de entrega é medido pela métrica `hookline_delivery_first_attempt_delay_seconds` e conferido no banco pelo teste de carga.
- A stack de observabilidade tem cinco serviços a mais, só no perfil `observability`. O desenvolvimento com `pnpm dev:*` e os testes não dependem dela.
- A propagação manual do contexto é código nosso, coberto pelo teste `tracing.test.ts`; quem mexer na outbox precisa manter a coluna `trace_context`.
- Sem Alertmanager, ninguém é avisado de madrugada: os alertas só aparecem para quem abrir o Prometheus ou o Grafana, até a fase 7.
- Os números de capacidade em `docs/capacity.md` valem para a máquina em que foram medidos, com tudo rodando junto.
