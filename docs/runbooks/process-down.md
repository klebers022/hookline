# Processo fora do ar

**Alerta:** `HooklineProcessDown` (crítico). O Prometheus não consegue ler as métricas de um processo do Hookline (API, relay ou carteiro) há 1 minuto.

## O que significa

O processo caiu, está travado ou não é alcançável pela rede. Com uma réplica só (relay e carteiro), a parte dele no caminho parou:

| Processo         | Efeito                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| API (2 réplicas) | a outra réplica atende; com as duas fora, o cliente recebe erro e precisa reenviar                            |
| relay            | nenhuma entrega sai; os eventos continuam sendo aceitos ([Outbox parada](outbox-stuck.md) dispara em seguida) |
| carteiro         | as mensagens se acumulam em `deliveries.ready`; nada se perde                                                 |

## Diagnóstico

```sh
kubectl -n hookline get pods -o wide
kubectl -n hookline describe pod <pod>
kubectl -n hookline logs <pod> --previous
```

| O que aparece                                 | Leitura                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CrashLoopBackOff`                            | o processo cai ao iniciar; o motivo está em `logs --previous` (variável de ambiente faltando, migração não aplicada, segredo errado) |
| `OOMKilled` em `describe`                     | passou do limite de memória                                                                                                          |
| reinícios por `Liveness probe failed`         | o processo travou e o Kubernetes o reiniciou; veja o que ele fazia antes nos logs                                                    |
| `Pending`                                     | sem recursos no nó, ou volume não montado                                                                                            |
| pod `Running` e pronto, mas o alerta continua | a NetworkPolicy ou o Prometheus; veja a página Targets do Prometheus                                                                 |

## Ação

- **Na maioria dos casos o Kubernetes já está reiniciando o processo.** Confirme que ele voltou.
- **Cai ao iniciar depois de uma versão nova:** [Voltar uma versão](rollback.md).
- **`OOMKilled` repetido:** veja o painel "Memória (RSS)" para saber se é vazamento (sobe sem parar) ou carga. Aumentar o limite é um paliativo, e a mudança entra por PR.
- **Travado sem reiniciar:** reinicie à mão. É seguro para qualquer um dos três:

  ```sh
  kubectl -n hookline rollout restart deploy/<api|relay|deliver>
  ```

## Confirmação

`kubectl -n hookline get pods` mostra todos `1/1 Running`, e o painel "No ar" volta a 1 para cada processo. Se o relay ou o carteiro ficaram fora por um tempo, espere um pico de entregas.
