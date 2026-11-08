# Capacidade

Números medidos com os cenários do k6 em `load-tests/` (`pnpm load:ingest` e `pnpm load:e2e`), em 8 de novembro de 2026.

## Onde foi medido

**Tudo na mesma máquina de desenvolvimento,** então os números valem para ela e servem de referência, não de garantia:

- **Máquina:** Windows 11 com Docker Desktop (WSL2); a VM do Docker tinha 12 CPUs e 7,7 GB de memória.
- **Na mesma máquina, ao mesmo tempo:** a stack (`pnpm stack:up`, com um processo de cada: API, relay e carteiro), Postgres 17, RabbitMQ 4.4, a observabilidade inteira (Prometheus, Tempo, Loki, Alloy e Grafana) e o próprio k6.
- **Configuração de carga:** os limites de pedidos da API e de envio por endpoint foram aumentados, para não serem eles o gargalo medido. O tracing ficou ligado, como é o padrão, exceto onde está indicado.
- **Destino:** cada evento vai para um endpoint, a casa de teste respondendo 200 na hora, para que o destino nunca seja o limite.
- **Configurações padrão:** pool de 10 conexões do `pg` por processo, `prefetch` 10 no carteiro e o Postgres com a configuração padrão da imagem.

## Resultados

### Ingestão: até onde o balcão aguenta

A taxa de publicação sobe de 50 a 800 eventos/s em 4 minutos. A partir de um ponto, a taxa aceita deixa de acompanhar a oferecida: é o limite.

| Taxa oferecida (eventos/s) | Aceita, com tracing | p99 da API, com tracing | Aceita, sem tracing | p99 da API, sem tracing |
| -------------------------- | ------------------- | ----------------------- | ------------------- | ----------------------- |
| ~180                       | 189                 | 466 ms                  | 193                 | 35 ms                   |
| ~320                       | 329                 | 83 ms                   | 333                 | 281 ms                  |
| ~415                       | 411                 | 575 ms                  | 427                 | 40 ms                   |
| ~470–485                   | 420 (satura)        | 2,5 s                   | 474                 | 118 ms                  |
| ~600                       | 428                 | 2,5 s                   | 596                 | 494 ms                  |
| ~670–700                   | 418                 | 2,5 s                   | 562 (satura)        | 2,5 s                   |

- **Vazão máxima da API, com tracing:** cerca de **415 eventos/s** por processo.
- **Sem tracing:** cerca de **590 eventos/s**. O tracing custa uns **30%** da vazão da API, porque cada pedido gera de 8 a 10 spans, cada um criado e serializado no próprio processo.
- **Nenhum erro** em nenhuma rodada: passado o limite, os pedidos esperam em vez de falhar.
- **O p99 oscila mesmo longe do limite** (de 35 ms a 466 ms em janelas vizinhas). A causa está em [Gargalos](#gargalos).

### Ponta a ponta: carga constante por 10 minutos

O script espera todas as entregas terminarem e mede pelo banco, que é a prova de que nada se perdeu.

| Medida                                              | 200 eventos/s        | 300 eventos/s          |
| --------------------------------------------------- | -------------------- | ---------------------- |
| Eventos aceitos                                     | 119.762              | 179.102                |
| Entregas concluídas (`succeeded`)                   | 119.762              | 179.102                |
| Entregas na DLQ, outbox pendente, retries           | 0, 0, 0              | 0, 0, 0                |
| API: p50 / p95 / p99                                | 5 / 27 / 494 ms      | 8 / 552 / 1.590 ms     |
| Atraso até a 1ª tentativa: p50 / p99 / máx.         | 167 / 872 / 2.253 ms | 212 / 3.420 / 4.886 ms |
| Primeiras tentativas dentro de 5 s (SLO)            | 100%                 | 100%                   |
| Entregas por segundo, do 1º evento à última entrega | 200                  | 298                    |
| Iterações que o k6 não conseguiu iniciar a tempo    | 238 (0,2%)           | 899 (0,5%)             |

Uma rodada curta de 60 s a 350 eventos/s também entregou tudo (21.000 eventos), com p99 da API de 106 ms e p99 até a 1ª tentativa de 452 ms.

**Nenhuma perda:** em todas as rodadas, cada evento aceito teve exatamente uma entrega concluída, sem nova tentativa e sem linha da outbox esquecida.

### Uso de recursos a 300 eventos/s

| Processo | CPU (núcleos) | Memória  |
| -------- | ------------- | -------- |
| API      | 0,75          | ~180 MiB |
| Carteiro | 0,70          | ~225 MiB |
| Relay    | 0,05          | ~100 MiB |
| Postgres | ~1,7          | ~215 MiB |
| RabbitMQ | ~0,3          | ~155 MiB |

O atraso do event loop do Node ficou entre 10 e 20 ms, e o tempo de GC foi desprezível, nos três processos.

**Carteiro:** cerca de 2,3 ms de CPU por entrega, o que dá uma **estimativa de 400 a 430 entregas/s por processo**. Esse número não foi medido até a saturação, porque a API satura antes.

## Gargalos

**1. A API é o primeiro limite de vazão.** Um processo do Node executa o app numa thread só, e a CPU da API chega a um núcleo perto de 415 eventos/s. O Postgres, o relay e o RabbitMQ ainda tinham folga.

**2. A latência de cauda vem de travadas do disco no `COMMIT`.** Os traces de pedidos lentos mostram sempre o mesmo padrão:

```text
POST /v1/events                      1.975 ms
├─ pg-pool.connect                   1.203 ms   ← esperando conexão livre
├─ pg.query: SELECT (API key)            3 ms
├─ pg-pool.connect                     741 ms   ← de novo, para a transação
└─ BEGIN, INSERT, SELECT, INSERT, INSERT, COMMIT   ~28 ms
```

- As consultas em si levam de 1 a 17 ms. O tempo vai na **espera por uma conexão do pool** (10 conexões).
- Buscando no Tempo os `COMMIT` acima de 200 ms, eles aparecem **agrupados nos mesmos segundos**, com até 1,2 s, e as esperas no pool acontecem exatamente nesses instantes.
- Quando o Postgres grava o WAL no disco (`fsync`) e o disco virtual do Docker Desktop trava, **todas as conexões ficam presas no `COMMIT` ao mesmo tempo**, e os pedidos seguintes fazem fila no pool.
- Os checkpoints não explicam isso: durante os testes, todos foram por tempo, espalhados por 270 s, com `sync` de no máximo 0,25 s.
- Por isso o p99 oscila mesmo a 200 eventos/s, com a CPU sobrando. A rajada que se acumula no balcão chega de uma vez à esteira, e é ela que leva o atraso até a 1ª tentativa ao p99 de 3,4 s a 300 eventos/s.

**3. Cada pedido pega o pool duas vezes:** uma para conferir a API key e outra para a transação. Numa travada, ele entra duas vezes na fila.

## SLOs revisados

| SLO                                                      | Meta inicial | Medido                                                           | Decisão                                                                                              |
| -------------------------------------------------------- | ------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Ingestão: p99 do `POST /v1/events`                       | < 200 ms     | 494 ms a 200/s e 1,6 s a 300/s, por 10 min; p95 de 27 ms a 200/s | **Mantida**, a ser medida de novo na VPS (fase 7). Nesta máquina, a cauda é do disco, não do código. |
| Entrega: primeiras tentativas iniciadas em até 5 s       | 99%          | 100% a 200/s e a 300/s; p99 de 0,9 s e 3,4 s                     | **Mantida.** A 300/s, a folga é pequena (máximo de 4,9 s).                                           |
| Durabilidade: nenhum evento aceito sem estado rastreável | zero         | zero em 320 mil eventos                                          | **Mantida.**                                                                                         |

**Capacidade de referência para os próximos passos:** 200 eventos/s sustentados com todos os SLOs de entrega e durabilidade cumpridos, e até cerca de 415 eventos/s de pico de ingestão por processo da API.

## O que melhoraria os números

Fica registrado para quando a carga real pedir; nada disso entra agora:

- **Conferir a API key sem um segundo uso do pool,** usando a mesma conexão da transação ou um cache curto em memória. Isso tira uma das duas filas.
- **Mais réplicas da API.** O relay usa `FOR UPDATE SKIP LOCKED` e a API não guarda estado, então escalar horizontalmente é direto (fase 6).
- **Um pool maior não resolve a travada do disco,** só aumenta quantas conexões ficam presas juntas.
- **`synchronous_commit = off` acabaria com a espera do `fsync`,** mas um evento respondido com `202` poderia sumir numa queda do Postgres. Isso quebra a promessa do produto, então está fora.
- **Amostrar os traces** (por exemplo, 10% dos pedidos) devolveria boa parte dos 30% que o tracing custa, mantendo os traces de erro.
- **Medir de novo na VPS** (fase 7), com disco real e sem a observabilidade e o k6 disputando a mesma máquina.

## Como repetir

```sh
pnpm stack:up
pnpm obs:up
pnpm load:ingest
RATE=300 pnpm load:e2e
OTEL_SDK_DISABLED=true pnpm load:ingest
```

Durante a carga, a linha "Carga (k6)" do painel no Grafana mostra o oferecido e o aceito. Para achar a causa de um pedido lento, busque no Tempo `{ name = "POST /v1/events" && duration > 1s }`.
