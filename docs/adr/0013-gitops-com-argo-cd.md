# ADR 0013: GitOps com Argo CD e imagens fixadas por SHA

**Status:** aceita

## Contexto

Com a stack no Kubernetes (ADR 0012), falta decidir como uma versão chega ao cluster. Um `kubectl apply` feito pelo CI exigiria expor a API do cluster e guardar um acesso de administrador nos segredos do GitHub. Também não deixaria registro do que está rodando além da memória de quem aplicou.

## Decisão

**GitOps por _pull_ com Argo CD.** O Argo CD roda dentro do cluster e lê este repositório; ninguém de fora precisa de acesso à API do cluster. A instalação (`infra/k8s/argocd/install`) usa o manifesto oficial fixado por versão e muda três coisas:

- HTTP simples atrás do Traefik (o TLS vem na fase 7);
- leitura sem login, só no cluster local;
- a interface em `argocd.hookline.localhost:8088`.

**Uma aplicação raiz (_app of apps_).** A `root` sincroniza `infra/k8s/argocd/apps` a partir da `main`. Ali estão o `AppProject` e as aplicações `hookline` (overlay `local`) e `observability`. O projeto só aceita este repositório, os namespaces `hookline` e `observability` e, como objeto do cluster todo, apenas os namespaces.

**Sincronização automática com `prune` e `selfHeal`:**

- o que sai do Git sai do cluster;
- uma mudança feita à mão é desfeita em segundos. Testado: um `kubectl scale --replicas=0` no carteiro voltou para 1 em menos de 2 s.

**Imagens fixadas por SHA no Git.** O overlay `local` usa `sha-<commit>`, nunca `main` ou `latest`. O `pnpm k8s:bump`:

- busca o último commit da `main`;
- confere no GHCR que as quatro imagens desse commit existem, ou seja, que passaram pelo Trivy e foram publicadas;
- grava o SHA no overlay.

A troca entra por pull request; depois do merge, o Argo CD faz o rollout, e um `git revert` volta a versão.

## Alternativas consideradas

- **`kubectl apply` pelo CI (_push_):** exige expor a API do cluster e um segredo de administrador no GitHub.
- **Flux:** faz o mesmo papel, mas o Argo CD tem uma interface que mostra o estado de cada recurso, útil para aprender e para demonstrar.
- **Tag `main` com `imagePullPolicy: Always`:** o Git deixaria de dizer qual versão está rodando, e não haveria como voltar com um `revert`.
- **Argo CD Image Updater ou um bump automático pelo CI:** a `main` é protegida, e um PR aberto com o `GITHUB_TOKEN` não dispara os checks obrigatórios. Automatizar exige um GitHub App, que fica para a fase 7.

## Consequências

- O que está no cluster é o que está na `main`. Mudar algo no cluster é abrir um PR.
- O bump é manual nesta fase: um comando e um PR por versão.
- O Secret `hookline-secrets` não está no Git e não é gerenciado pelo Argo CD; o Sealed Secrets resolve isso na fase 7.
- O Argo CD lê o GitHub pela internet, então um cluster sem saída não sincroniza.
