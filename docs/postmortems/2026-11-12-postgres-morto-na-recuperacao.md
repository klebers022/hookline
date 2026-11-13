# Postmortem: o Kubernetes matou o Postgres no meio da recuperação

|              |                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Data**     | 12 de novembro de 2026                                                                                                      |
| **Ambiente** | k3d local, rodada completa do teste de caos (fase 8, etapa A)                                                               |
| **Duração**  | Postgres fora por cerca de 85 s, em vez de cerca de 15; ingestão parada por cerca de 3 minutos                              |
| **Impacto**  | nenhum evento aceito perdido; 835 entregas do destino `flaky` terminaram `dead` por prazo vencido, e a prova do caos falhou |
| **Correção** | #46                                                                                                                         |
| **Situação** | resolvido; a rodada de 13 de novembro passou nas 9 verificações                                                             |

Este postmortem é _sem culpados_: o objetivo é entender por que o sistema permitiu a falha, não quem errou.

## Resumo

O teste de caos derruba o Postgres com SIGKILL no meio de um envio de 10 mil eventos. Depois de uma queda assim, o Postgres relê o log de escrita (WAL) antes de aceitar conexões e, enquanto isso, responde "rejecting connections". A sonda de vida (`livenessProbe`) usava o `pg_isready`, que devolve código 1 nessa situação, e o Kubernetes tratou isso como falha. Depois de 6 falhas, o Kubernetes reiniciou o Postgres no meio da recuperação. A segunda tentativa terminou em 0,33 s, mas o banco ficou fora cerca de 85 s, e a ingestão parou por cerca de 3 minutos.

Na analogia dos Correios: o livro de registros caiu, e o escrivão começou a reorganizar as páginas. O gerente de operações perguntou se ele estava trabalhando, ouviu "estou arrumando, ainda não atendo", concluiu que ele tinha travado e o trocou por outro, que teve de recomeçar a arrumação.

## Linha do tempo (UTC)

| Hora                | Evento                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 21:53:33            | Começa a rodada: 10 mil eventos a 50/s, com seis falhas programadas                                                                                                |
| 21:55:30            | Uma das duas APIs é desligada (SIGTERM). A outra atende sozinha e fica lenta                                                                                       |
| 21:55:55            | O Postgres é morto (SIGKILL). As conexões abertas recebem `57P01`, e a API, o relay e o carteiro registram `Database connection lost`                              |
| 21:56:00            | A API passa a registrar `getaddrinfo EAI_AGAIN postgres`: sem o pod pronto, o nome some do DNS do cluster                                                          |
| 21:56:11            | O novo contêiner do Postgres começa e inicia a recuperação                                                                                                         |
| 21:56:17            | Primeiras falhas da sonda de vida: `no response`, com o tempo limite padrão de 1 s                                                                                 |
| 21:56:27            | A sonda de vida passa a falhar com `rejecting connections`: o Postgres está recuperando                                                                            |
| 21:57:06            | Sexta falha seguida. O Kubernetes reinicia o contêiner: `Container postgres failed liveness probe, will be restarted`                                              |
| 21:57:19            | O Postgres começa de novo: `database system was shut down in recovery`. O redo leva 0,33 s                                                                         |
| 21:57:20            | `database system is ready to accept connections`                                                                                                                   |
| 21:57:20 a 21:58:20 | A API volta a aceitar, mas os clientes do k6 estão esperando para repetir (espera crescente de até 10 s), e o atraso acumulado leva cerca de um minuto para escoar |
| Minutos seguintes   | 835 entregas do destino `flaky` passam do prazo do calendário de caos (285 s) e vão para `dead` com `DEADLINE_EXCEEDED`                                            |

## Como foi detectado

A prova do caos falhou numa das nove verificações: o destino `flaky`, que deveria receber todas as entregas, teve 835 `dead`. Nenhum alerta disparou: o Postgres não exporta métricas nesta versão, e a queda durou menos do que a janela do `HooklineOutboxStuck`.

## Investigação

1. **Os logs do nginx do painel** mostraram, a partir das 21:55:30, uma maioria de `499` (o cliente desistiu) e `502`, com `connect() failed (111: Connection refused)` ao falar com a API. A primeira hipótese foi o encerramento de uma réplica da API.
2. **Os logs da API, agrupados a cada 10 s,** mostraram outra coisa: entre 21:56:00 e 21:57:20, a API remanescente só registrava `getaddrinfo EAI_AGAIN postgres`. O balcão estava esperando o livro de registros.
3. **Os eventos do pod `postgres-0`** mostraram a causa: o contêiner tinha começado às 21:56:11, falhou na sonda de vida com `rejecting connections` e foi reiniciado às 21:57:06. Os logs do Postgres confirmaram: `database system was shut down in recovery`.

## Causa

**A sonda de vida perguntava se o Postgres estava pronto, não se estava vivo.**

- O `pg_isready` devolve 0 quando o servidor aceita conexões, 1 quando responde mas recusa (recuperando ou desligando) e 2 quando não responde. A sonda tratava 1 como morte.
- Não havia `startupProbe`: a sonda de vida começava a contar logo depois da partida, sem dar tempo para a recuperação.
- O tempo limite padrão de 1 s também falhava com o notebook sob carga (`no response`).

**Por que a primeira recuperação demorou:** não está claro. Os mesmos registros foram relidos em 0,33 s na segunda partida. A hipótese mais provável é disputa de disco no notebook durante o caos: um checkpoint logo depois levou 224 s para gravar 15 MB. A correção não depende disso: com mais dados, a recuperação seria longa de qualquer jeito.

**Por que a parada foi além da queda:** com o banco fora, os clientes repetiam os pedidos com espera crescente, e o atraso levou mais um minuto para escoar. O atraso acumulado, somado ao disjuntor aberto do destino, empurrou 835 entregas além do calendário curto do overlay de caos.

## Correção

No #46, em `infra/k8s/base/postgres.yaml`:

- **`startupProbe`** com o `pg_isready`, por até 5 minutos (60 × 5 s). A sonda de vida só começa depois que o Postgres aceita conexões pela primeira vez.
- **Sonda de vida** que só falha quando o servidor não responde (`pg_isready ...; [ $? -le 1 ]`).
- **`timeoutSeconds: 5`** nas três sondas.

**Verificação:** a rodada de 13 de novembro passou nas 9 verificações. O Postgres foi morto às 18:52:16 e começou de novo no segundo seguinte, sem reinício pela sonda de vida.

## O que deu certo

- **Nenhum evento aceito se perdeu.** O livro e a outbox seguraram tudo, e a API, o relay e o carteiro sobreviveram à queda do banco (correção do #45, da rodada anterior).
- **A prova do caos pegou o problema**, mesmo sem nenhum alerta.
- **Os logs estruturados** permitiram agrupar os eventos por tempo e separar duas causas que pareciam uma (a réplica da API desligada e o Postgres fora).

## O que deu errado

- A sonda de vida foi escrita como uma sonda de prontidão.
- Não havia sinal direto de "Postgres fora": só os efeitos dele.
- A primeira hipótese (o desligamento da API) estava errada e custou uma rodada de investigação.

## Ações

| Ação                                                                                                                                 | Situação                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sondas do Postgres: `startupProbe` e sonda de vida tolerante à recuperação                                                           | feito (#46)                                                                                                                                                  |
| Runbook de Postgres fora do ar                                                                                                       | feito ([postgres-down.md](../runbooks/postgres-down.md))                                                                                                     |
| Revisar as sondas dos outros pods com a mesma pergunta: "a sonda de vida falha quando o processo está só ocupado ou se recuperando?" | feito: o RabbitMQ já tinha `startupProbe` e usa `check_running` na sonda de vida; a API e os workers usam `/healthz`, que não depende do banco nem do broker |
| Alerta próprio para Postgres e RabbitMQ fora do ar                                                                                   | a fazer                                                                                                                                                      |

## Lição

**A sonda de vida responde "este processo precisa ser reiniciado?", e não "este processo pode atender agora?".** Um banco que se recupera não está atendendo, mas reiniciá-lo só piora as coisas. Essa pergunta é da sonda de prontidão, que o tira do Service sem matá-lo.
