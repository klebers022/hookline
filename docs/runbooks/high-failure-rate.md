# Muitas falhas de entrega

**Alerta:** `HooklineHighFailureRate` (aviso). Mais da metade das entregas dos últimos 5 minutos falhou ou esperou num disjuntor aberto, há 2 minutos.

## O que significa

Destinos falham o tempo todo, e as novas tentativas cuidam disso. **A maioria falhando ao mesmo tempo** sugere um problema comum: a rede de saída do cluster, o DNS ou o próprio Hookline. Também pode ser um único cliente grande com o destino fora do ar.

## Diagnóstico

1. **É um destino só ou são vários?**

   ```sql
   SELECT e.url, a.response_status, a.error_code, count(*)
   FROM delivery_attempts a
   JOIN deliveries d ON d.id = a.delivery_id
   JOIN endpoints e ON e.id = d.endpoint_id
   WHERE a.started_at > now() - interval '15 minutes'
     AND (a.response_status IS NULL OR a.response_status NOT BETWEEN 200 AND 299)
   GROUP BY 1, 2, 3
   ORDER BY 4 DESC
   LIMIT 20;
   ```

2. **Disjuntores abertos:**

   ```sql
   SELECT url, consecutive_failures, circuit_open_until
   FROM endpoints
   WHERE circuit_open_until > now();
   ```

3. **Erros sem resposta HTTP:** o painel "Erros sem resposta HTTP" separa os erros por código (`TIMEOUT`, `ENOTFOUND` de DNS, `ECONNREFUSED` e outros). Muitos erros de DNS ou de conexão em destinos diferentes apontam para a rede do cluster.

4. **A saída funciona?** Teste de dentro do pod do carteiro:

   ```sh
   kubectl -n hookline exec deploy/deliver -- node -e "fetch('https://example.com').then(r => console.log(r.status))"
   ```

## Ação

- **Um destino só:** é o caso comum, e o disjuntor já está protegendo os outros clientes. Avise o cliente. As entregas esperam sem gastar tentativas e saem quando ele voltar; se ele passar do calendário, elas vão para a DLQ ([Entregas na DLQ](dead-letters.md)).
- **Rede ou DNS do cluster:** verifique o CoreDNS (`kubectl -n kube-system get pods`) e a saída do nó. As entregas continuam guardadas e são tentadas de novo quando a rede voltar.
- **Erro do Hookline** (por exemplo, todas as tentativas com o mesmo erro logo depois de uma versão nova): [Voltar uma versão](rollback.md).

## Confirmação

O painel "Tentativas/s por resultado" volta a ser quase todo `succeeded`, e os disjuntores fecham.
