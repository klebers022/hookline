# ADR 0014: Backup lógico com pg_dump, guardado num armazenamento S3

**Status:** aceita

## Contexto

O Postgres é a fonte da verdade do Hookline: eventos, entregas, tentativas e outbox. O volume dele é um PVC de um nó só (ADR 0012). Um disco perdido, um `DROP` por engano ou uma migração errada apagariam tudo, e não havia cópia.

O plano original previa backup diário para o Object Storage da OCI na fase 7. Sem a VPS (ver a ADR sobre produção, na etapa D da fase 8), o backup precisa existir e ser testado no próprio cluster.

## Decisão

**`pg_dump` diário, em formato custom (`-Fc`), por um CronJob.**

- Roda às 02:30 UTC, meia hora antes da retenção. Assim, sempre existe uma cópia do que a retenção vai apagar.
- O `pg_dump` lê um único snapshot consistente, então a cópia é coerente mesmo com a API escrevendo.
- O formato custom é comprimido (2,6 MB para cerca de 70 mil linhas no teste) e permite restaurar só uma parte, se for preciso.

**Guardado num armazenamento compatível com S3, o Versity S3 Gateway, dentro do cluster.**

- Envio com o `rclone`, configurado só por variáveis de ambiente.
- O próprio job apaga as cópias com mais de 7 dias.
- As chaves ficam no Secret `hookline-backup`, criado pelo `pnpm k8s:up` como os outros (fora do Git).
- NetworkPolicy: só o backup, o teste de restauração e a restauração alcançam o armazenamento.

**A restauração é testada, não suposta.** O `pnpm k8s:restore-test`:

1. faz um backup na hora, a partir do modelo do próprio CronJob;
2. restaura a cópia num Postgres descartável, dentro de um pod;
3. compara a contagem de linhas de cada tabela com o banco vivo.

Ele roda no job `k8s` do CI, depois do teste de caos.

**Restaurar sobre o banco vivo é um comando** (`pnpm k8s:restore [cópia]`):

- para a API, o relay e o carteiro;
- restaura com `--clean --single-transaction`, então uma falha deixa o banco como estava;
- religa os processos, mesmo quando falha;
- recusa rodar com o Argo CD sincronizando sozinho, que religaria os processos no meio da restauração.

O procedimento está em `docs/runbooks/restore.md`.

## Alternativas consideradas

- **MinIO:** era o plano. As imagens oficiais (`minio/minio` no Docker Hub e no Quay) não são mais distribuídas, e fixar uma imagem que não se consegue baixar quebra o CI. O Versity S3 Gateway é um processo só, com licença Apache 2.0, e grava os objetos como arquivos comuns, o que facilita inspecionar.
- **SeaweedFS ou Garage:** também falam S3, mas exigem mais peças (mestre, volumes, filer) ou um layout de cluster para configurar. É peso demais para guardar um arquivo por dia.
- **Backup físico com WAL contínuo (pgBackRest, WAL-G):** permite voltar a qualquer instante, não só à última cópia diária. É o certo para produção com dados de clientes, mas traz o arquivamento de WAL, a retenção de base backups e mais um processo para operar. Para um banco de demonstração, o RPO de um dia é aceitável.
- **Operador (CloudNativePG):** resolveria backup e réplicas juntos, mas substituiria o StatefulSet escrito à mão, que é parte do que este projeto mostra (ADR 0012).
- **Snapshot do volume:** o `local-path` do k3s não tem snapshots.

## Consequências

- **RPO de até 24 horas:** uma restauração perde o que foi aceito depois da última cópia. Um backup sob demanda (`pnpm k8s:backup`) antes de uma operação arriscada encurta essa janela.
- **A cópia mora no mesmo cluster.** Protege contra um `DROP` ou uma migração errada, mas não contra a perda do nó. Em produção, o mesmo job aponta para um armazenamento fora do cluster (o Object Storage da OCI fala S3) trocando o endpoint e as chaves.
- **Depois de uma restauração, as filas não batem com o banco.** O carteiro ignora mensagens de entregas que não existem mais (`Delivery not found`). Já as entregas que voltam como `pending` ou `retrying`, mas cuja mensagem já foi consumida, ficam paradas: é a mesma limitação do runbook de RabbitMQ fora do ar.
- **Ainda não há alerta de backup atrasado ou falho:** o cluster não roda o kube-state-metrics, que exporia o último sucesso do CronJob.
