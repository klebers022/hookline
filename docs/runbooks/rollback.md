# Voltar uma versão

**Quando usar:** logo depois de uma versão nova, algo piorou: um processo cai ao iniciar, a taxa de falhas subiu, a API responde erros.

## Como a versão é definida

O overlay `infra/k8s/overlays/local` fixa as imagens por SHA (`newTag: sha-<commit>`). O `pnpm k8s:bump` muda essa tag por PR, e o Argo CD aplica o que está na `main` (ADR 13). **Voltar a versão é reverter esse commit.**

## Ação

1. **Ache o commit da troca de versão:**

   ```sh
   git log --oneline -- infra/k8s/overlays/local/kustomization.yaml
   ```

2. **Reverta por PR**, como qualquer mudança:

   ```sh
   git switch -c revert-bump origin/main
   git revert <commit>
   git push -u origin revert-bump
   gh pr create --fill
   ```

3. **Depois do merge, o Argo CD faz o rollout sozinho.** Acompanhe:

   ```sh
   kubectl -n argocd get applications
   kubectl -n hookline rollout status deploy/api
   ```

### Com pressa

Se esperar o CI custar caro, use o rollback do Argo CD (**History and rollback** na interface). Ele só funciona com a sincronização automática desligada na Application `hookline`, porque senão o Argo CD voltaria logo para o que está na `main`. Abra o PR do revert em seguida e religue a sincronização automática depois do merge.

## Migrações

**A volta da imagem não desfaz uma migração.** As migrações rodam antes dos apps (Job na onda 1 do Argo CD) e só andam para a frente. Por isso, cada migração precisa funcionar com a versão anterior do código: acrescentar colunas e tabelas, nunca renomear nem apagar na mesma versão em que o código para de usá-las.

Se uma migração quebrou a versão anterior, escreva uma migração nova que corrija o esquema, em vez de voltar a imagem.

## Confirmação

`kubectl -n hookline get pods` mostra os pods com a imagem anterior:

```sh
kubectl -n hookline get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image
```

E o sintoma que motivou a volta desaparece do painel.
