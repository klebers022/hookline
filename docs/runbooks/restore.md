# Restaurar o backup

**Quando usar:** o banco perdeu dados ou ficou inconsistente: um `DELETE` ou `DROP` por engano, uma migração que estragou tabelas, um volume corrompido. Não use para uma queda simples do Postgres: veja [Postgres fora do ar](postgres-down.md).

## Antes de começar

**Tudo o que foi gravado depois do backup escolhido se perde:** eventos aceitos, tentativas, endpoints criados. O backup é diário (02:30 UTC), então a perda pode chegar a 24 horas. Tenha certeza de que restaurar é melhor do que corrigir os dados com SQL.

1. **Guarde o estado atual**, mesmo estragado, para poder voltar atrás ou investigar:

   ```sh
   pnpm k8s:backup
   ```

2. **Escolha a cópia.** As cópias dos últimos 7 dias aparecem no fim da saída do backup, uma por linha (`hookline-AAAAMMDDTHHMMSSZ.dump`). Escolha a última anterior ao problema.

3. **Com o Argo CD:** desligue a sincronização automática da Application `hookline`. Senão, ele religa os processos no meio da restauração. O script se recusa a rodar enquanto ela estiver ligada.

## Ação

```sh
pnpm k8s:restore hookline-20261113T200644Z.dump
```

Sem nome, restaura a cópia mais recente. O comando:

1. para a API, o relay e o carteiro, para nada escrever durante a troca;
2. busca a cópia no armazenamento de backup;
3. restaura com `pg_restore --clean --single-transaction`: ou tudo é trocado, ou o banco fica como estava;
4. religa os processos com o número de réplicas que tinham, mesmo se a restauração falhar.

Enquanto ele roda, a API está fora: os clientes recebem erro e reenviam depois. Com a `Idempotency-Key`, o reenvio não duplica eventos.

## Confirmação

```sh
kubectl -n hookline exec postgres-0 -- psql -U hookline -d hookline -c "SELECT count(*) FROM events"
kubectl -n hookline get pods
```

Os pods `api`, `relay` e `deliver` voltam a `1/1`, e as contagens batem com as da cópia. Religue a sincronização automática do Argo CD.

## Depois

- **Entregas em andamento:** as filas do RabbitMQ não voltam junto com o banco.
  - Mensagens de entregas que não existem mais são descartadas pelo carteiro (`Delivery not found` nos logs).
  - Entregas que voltaram como `pending` ou `retrying`, mas cuja mensagem já foi consumida, ficam paradas, a mesma limitação de [RabbitMQ fora do ar](rabbitmq-down.md). Liste-as:

    ```sql
    SELECT status, count(*) FROM deliveries
    WHERE status IN ('pending', 'retrying') GROUP BY 1;
    ```

- **Avise os clientes** do intervalo perdido: os eventos aceitos depois da cópia precisam ser reenviados.
- **Escreva o postmortem** em `docs/postmortems/`.

## Testar sem estragar nada

O `pnpm k8s:restore-test` faz um backup, restaura num Postgres descartável e compara a contagem de cada tabela com o banco vivo, sem tocar nele. O CI roda esse teste em cada PR.
