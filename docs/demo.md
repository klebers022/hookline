# Roteiro do vídeo de demonstração

Um vídeo de cerca de 6 minutos para quem avalia o projeto: o que o Hookline promete, a promessa funcionando, e a promessa resistindo a falhas.

**O vídeo é em português:** a narração é falada por uma voz sintética da ElevenLabs, e o mesmo texto aparece como legenda, num texto do OBS na parte de baixo da tela. Os comandos rodam no k3d local, como na seção "Experimente" do README.

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
5. **Narração:** um MP3 por cena, gerado pelo conector da ElevenLabs a partir da coluna "Narração e legenda" abaixo (ver [Narração](#narração)).
6. **OBS:**
   - saída em 1920×1080, 30 fps, gravação em MP4;
   - uma cena por bloco abaixo, cada uma com a captura da janela, o texto da legenda e uma fonte de mídia com o MP3 da cena, que toca ao entrar na cena;
   - entre as cenas, uma transição de corte;
   - nas esperas longas (o caos esvaziando as filas), a gravação é **pausada**, e a legenda diz quanto tempo passou.

## Cenas

A duração de cada cena acompanha a da narração; os tempos abaixo são aproximados.

| #   | Cena                        | Tempo     | Na tela                                                                                                                                                                                                                          | Narração e legenda                                                                                                                                                                                                                                                                                       |
| --- | --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Título                      | 0:00–0:15 | cartão com o nome e a frase do projeto                                                                                                                                                                                           | Hookline: entrega confiável de webhooks. O cliente publica um evento uma vez, e o Hookline garante que ele seja entregue pelo menos uma vez, ou fique guardado na fila de não entregues. Nunca perdido.                                                                                                  |
| 2   | Arquitetura                 | 0:15–0:50 | o diagrama "Como funciona" do README, rolando devagar até "Provado sob caos"                                                                                                                                                     | A API grava o evento, as entregas e uma linha de outbox numa única transação, e responde 202. O relay publica a outbox no RabbitMQ. O carteiro faz o POST assinado, registra cada tentativa e agenda a próxima na mesma transação. As esperas entre as tentativas são filas com prazo, não temporizadores. |
| 3   | Caminho feliz               | 0:50–1:30 | painel: entrar com a chave, **Send test event** (`order.paid`), abrir o evento e a entrega, `succeeded` em 1 tentativa                                                                                                           | Um evento de teste, aceito com 202. Um instante depois, o destino já recebeu, assinado no padrão Standard Webhooks, e a tentativa está registrada no painel.                                                                                                                                              |
| 4   | Falha e reenvio             | 1:30–2:30 | a casa de teste passa a responder 500 (comando no terminal); um evento novo; a entrega mostra as tentativas falhando e a próxima marcada; a casa volta a 200; **Failed → Retry**; a entrega muda para `succeeded` sem recarregar | Agora o destino começa a falhar. O Hookline tenta de novo seguindo um calendário, guarda cada resposta, e um disjuntor para de insistir num destino fora do ar. Quando ele volta, um clique reenvia, e o painel se atualiza sozinho.                                                                       |
| 5   | Caos: começo                | 2:30–3:15 | terminal: `pnpm chaos --events 2000 --rate 25`; ao lado, o Grafana; as linhas "Killed the delivery worker", "Killed the relay", "Killed RabbitMQ" aparecendo                                                                     | Hora do teste de caos: dois mil eventos, enquanto o script derruba o carteiro, o relay e o RabbitMQ…                                                                                                                                                                                                      |
| 6   | Caos: as quedas mais sérias | 3:15–4:00 | "Stopped one API pod", "The outage destination is back", "Killed Postgres"; no Grafana, as filas de espera crescendo e os disjuntores abertos                                                                                    | …depois, um pod da API e o próprio Postgres. Ao mesmo tempo, um destino está fora do ar e outro sempre falha. Os eventos aceitos esperam na outbox e nas filas de espera.                                                                                                                                 |
| 7   | Caos: a prova               | 4:00–4:45 | (gravação pausada enquanto as entregas terminam) a tabela por destino e as 9 linhas `PASS`                                                                                                                                       | A prova: cada evento aceito está no banco exatamente uma vez. Cada entrega terminou, entregue ou morta depois de todo o calendário. A casa de teste contou cada uma. Nada se perdeu.                                                                                                                      |
| 8   | Operação                    | 4:45–5:35 | Grafana: um trace no Tempo do `POST /v1/events` à entrega; depois o terminal com `pnpm k8s:restore-test` e "The restored copy matches the live database"                                                                         | Um único trace acompanha o evento através da fila. Cada alerta aponta para um runbook. E o backup diário é restaurado e comparado, tabela por tabela, em cada pull request.                                                                                                                               |
| 9   | Encerramento                | 5:35–5:50 | cartão com o link do repositório e a lista: ADRs, teste de caos, capacidade, runbooks, postmortem                                                                                                                                | Feito com Node.js, PostgreSQL, RabbitMQ, k3s, Argo CD, OpenTelemetry e Grafana. Está tudo no repositório.                                                                                                                                                                                                 |

## Narração

- **Gerada pelo conector da ElevenLabs**, uma faixa por cena, com o texto da coluna "Narração e legenda" sem mudanças, para a fala e a legenda baterem.
- **Voz:** masculina, português do Brasil, tom calmo de explicação (escolhida por uma amostra antes de gerar o resto).
- **Modelo:** `eleven_multilingual_v2`, o mais estável para pt-BR em textos técnicos.
- **Arquivos:** `cena-01.mp3` a `cena-09.mp3`, numa pasta fora do repositório, junto da gravação.
- **Se a cena mudar,** só aquela faixa é gerada de novo.

## Notas

- **A rodada do vídeo é menor que a do `docs/chaos.md`** (2 mil eventos em vez de 10 mil), para caber no tempo. As falhas são as mesmas, na mesma ordem. A rodada completa está documentada.
- **Os textos do painel e a saída do terminal ficam em inglês,** como no código; a narração explica o que aparece.
- **Nenhum segredo aparece na tela:**
  - a API key é colada no painel a partir de um arquivo, e o campo é de senha;
  - o terminal não mostra a saída do `k8s:project`.
- **Se algo der errado numa cena**, ela é regravada sozinha: cada cena é um trecho separado da gravação (`SplitRecordFile`), e os trechos são juntados no fim.
- **O vídeo não entra no Git.** Fica no YouTube (não listado) ou como asset de uma release do GitHub, publicado pelo dono do repositório, e o link entra no README.
