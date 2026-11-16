# Roteiro do vídeo de demonstração

Um vídeo de cerca de 6 minutos para quem avalia o projeto: o que o Hookline promete, a promessa funcionando, e a promessa resistindo a falhas.

O vídeo não tem narração falada. **As falas são legendas**, num texto do OBS na parte de baixo da tela, em inglês, para o vídeo servir a qualquer avaliador. Os comandos rodam no k3d local, como na seção "Try it" do README.

## Preparação

1. **Cluster com o overlay de caos e a observabilidade:**

   ```sh
   pnpm k8s:images
   pnpm k8s:up chaos
   pnpm k8s:obs
   pnpm k8s:project demo   # a chave vai para um arquivo fora do repositório, não para a tela
   ```

2. **Destinos da demonstração** (cenas 3 e 4): um endpoint na casa de teste respondendo 200, para o tipo `order.paid`.
3. **Navegador** em 1920×1080, zoom de 125%, tema claro. Abas abertas:
   - o README no GitHub;
   - o painel (`hookline.localhost:8088`);
   - o Grafana (`grafana.hookline.localhost:8088`, painel "Hookline – visão geral", últimos 15 minutos).
4. **Terminal** com fonte grande (18 pt), já na pasta do projeto, com o histórico limpo.
5. **OBS:**
   - saída em 1920×1080, 30 fps, gravação em MP4;
   - uma cena por bloco abaixo, cada uma com a captura da janela e o texto da legenda;
   - entre as cenas, uma transição de corte;
   - nas esperas longas (o caos esvaziando as filas), a gravação é **pausada**, e a legenda diz quanto tempo passou.

## Cenas

| #   | Cena                        | Tempo     | Na tela                                                                                                                                                                                                                          | Legenda                                                                                                                                                                                                              |
| --- | --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Título                      | 0:00–0:10 | cartão com o nome e a frase do projeto                                                                                                                                                                                           | **Hookline.** Reliable webhook delivery: publish an event once, and it is delivered at least once or kept in a dead-letter queue, never lost.                                                                        |
| 2   | Arquitetura                 | 0:10–0:45 | o diagrama "How it works" do README, rolando devagar até "Proven under chaos"                                                                                                                                                    | The API writes the event, its deliveries and an outbox row in one transaction. A relay publishes the outbox to RabbitMQ; a worker delivers, records each attempt and schedules the next one in the same transaction. |
| 3   | Caminho feliz               | 0:45–1:30 | painel: entrar com a chave, **Send test event** (`order.paid`), abrir o evento e a entrega, `succeeded` em 1 tentativa                                                                                                           | A test event, accepted with 202. A moment later the endpoint has it, signed with Standard Webhooks, and the attempt is recorded.                                                                                     |
| 4   | Falha e reenvio             | 1:30–2:30 | a casa de teste passa a responder 500 (comando no terminal); um evento novo; a entrega mostra as tentativas falhando e a próxima marcada; a casa volta a 200; **Failed → Retry**; a entrega muda para `succeeded` sem recarregar | The endpoint starts failing. Hookline retries on a schedule, records every response, and a circuit breaker stops hammering it. Once it is back, one click retries, and the dashboard updates by itself.              |
| 5   | Caos: começo                | 2:30–3:15 | terminal: `pnpm chaos --events 2000 --rate 25`; ao lado, o Grafana; as linhas "Killed the delivery worker", "Killed the relay", "Killed RabbitMQ" aparecendo                                                                     | Now the chaos test: 2,000 events while it kills the delivery worker, the relay and RabbitMQ…                                                                                                                         |
| 6   | Caos: as quedas mais sérias | 3:15–4:00 | "Stopped one API pod", "The outage destination is back", "Killed Postgres"; no Grafana, as filas de espera crescendo e os disjuntores abertos                                                                                    | …one API pod and Postgres itself. Meanwhile one destination is down and another always fails. Accepted events wait in the outbox and the wait queues.                                                                |
| 7   | Caos: a prova               | 4:00–4:45 | (gravação pausada enquanto as entregas terminam) a tabela por destino e as 9 linhas `PASS`                                                                                                                                       | Every accepted event is in the database once. Every delivery ended: delivered, or dead after its whole schedule. The receiver counted each one. Nothing was lost.                                                    |
| 8   | Operação                    | 4:45–5:35 | Grafana: um trace no Tempo do `POST /v1/events` à entrega; depois o terminal com `pnpm k8s:restore-test` e "The restored copy matches the live database"                                                                         | One trace follows an event across the queue. Alerts link to runbooks. A nightly backup is restored and compared table by table on every pull request.                                                                |
| 9   | Encerramento                | 5:35–5:50 | cartão com o link do repositório e a lista: ADRs, chaos test, capacity, runbooks, postmortem                                                                                                                                     | Built with Node.js, PostgreSQL, RabbitMQ, k3s, Argo CD, OpenTelemetry and Grafana. Everything is in the repository.                                                                                                  |

## Notas

- **A rodada do vídeo é menor que a do `docs/chaos.md`** (2 mil eventos em vez de 10 mil), para caber no tempo. As falhas são as mesmas, na mesma ordem. A rodada completa está documentada.
- **Nenhum segredo aparece na tela:**
  - a API key é colada no painel a partir de um arquivo, e o campo é de senha;
  - o terminal não mostra a saída do `k8s:project`.
- **Se algo der errado numa cena**, ela é regravada sozinha: cada cena é um trecho separado da gravação (`SplitRecordFile`), e os trechos são juntados no fim.
- **O vídeo não entra no Git.** Fica no YouTube (não listado) ou como asset de uma release do GitHub, publicado pelo dono do repositório, e o link entra no README.
