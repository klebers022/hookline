# ADR 0012: Kubernetes com k3s, manifestos Kustomize e estado em StatefulSets próprios

**Status:** aceita

## Contexto

Até a fase 5, a stack inteira subia com o Docker Compose numa máquina só. Nada reiniciava um processo travado, nada limitava a memória de cada um, e qualquer contêiner da rede alcançava o banco. A produção (fase 7) será uma VPS ARM de nó único, sem orçamento para um Kubernetes gerenciado.

## Decisão

**k3s, e k3d para rodá-lo localmente.** O k3s é um Kubernetes completo num binário só, com Traefik, um provisionador de volumes locais e NetworkPolicies já incluídos. O k3d roda o k3s dentro do Docker. O cluster local (`infra/k8s/k3d.yaml`) tem um servidor e um agente, publica o Traefik em `127.0.0.1:8088` e fixa a versão do k3s, que é a mesma da VPS.

**Kustomize, com uma base e overlays:**

- `infra/k8s/base`: o que vale em qualquer lugar.
- `overlays/local`: as imagens do GHCR fixadas por SHA e a casa de teste.
- `overlays/ci`: as imagens construídas no job e esperas de 1 s.

A fase 7 acrescenta um overlay `prod` sem copiar manifestos.

**Postgres e RabbitMQ como StatefulSets escritos à mão.** Cada um tem um pod de nome fixo, um volume próprio e um Service _headless_. O RabbitMQ guarda as filas sob o nome do nó (`rabbit@rabbitmq-0`), e o StatefulSet mantém esse nome entre reinícios.

**Probes e recursos em todos os pods:**

- a _readiness_ (`/readyz`) tira do Service um pod que ainda não alcança o banco ou a fila;
- a _liveness_ (`/healthz`) reinicia um processo travado;
- `requests` e `limits` evitam que um vazamento derrube o nó;
- o tempo de encerramento (35 a 40 s) cobre os 30 s do encerramento gracioso;
- a API faz uma pausa de 5 s no `preStop`, para o Traefik deixar de mandar pedidos antes do `SIGTERM`.

**Migrações num Job**, que o Argo CD roda como hook `Sync` na onda 1: depois do Postgres (onda 0) e antes dos apps (onda 2). Um `PreSync` rodaria antes de o Postgres existir na primeira sincronização.

**Segurança no padrão `restricted`:**

- Os namespaces `hookline` e `observability` aplicam o Pod Security `restricted`: todo pod roda com usuário sem root, sem _capabilities_, sem escalada de privilégio e com seccomp.
- O disco raiz é só de leitura, com `emptyDir` onde for preciso gravar.
- Não há `fsGroup`: ele deixava os arquivos do volume legíveis pelo grupo, e o RabbitMQ recusa um cookie do Erlang assim.

**NetworkPolicies com entrada negada por padrão:**

- O Traefik só fala com o painel e o Grafana.
- O painel só fala com a API.
- Só os processos do Hookline abrem o Postgres, e só o relay e o carteiro usam o RabbitMQ.
- A saída fica aberta, porque o carteiro chama URLs de clientes; a proteção contra SSRF continua no código.
- O k3s aplica as regras a um pod novo um instante depois de ele subir, então os Jobs esperam o Postgres responder num _init container_.

**Segredos fora do Git até a fase 7.** O `pnpm k8s:up` gera senhas e a chave de criptografia aleatórias e cria o Secret direto no cluster. O Sealed Secrets entra com o cluster duradouro da VPS.

**Observabilidade com a mesma configuração do compose.** O `infra/observability/kustomization.yaml` transforma os alertas, o painel e as configurações do Tempo e do Loki em ConfigMaps. Muda só a descoberta:

- o Prometheus acha os pods pela API do Kubernetes;
- o Alloy lê os logs pela mesma API, numa réplica só, porque um DaemonSet precisaria de `hostPath`, que o padrão `restricted` proíbe.

## Alternativas consideradas

- **minikube ou kind:** rodam outro Kubernetes, não o da produção, e sem as NetworkPolicies e o Traefik do k3s.
- **Helm:** os charts escondem os manifestos atrás de templates. O Kustomize mantém o YAML legível e é nativo do `kubectl`.
- **Operadores (CloudNativePG, RabbitMQ Cluster Operator):** trariam backup e failover prontos, mas escondem o mecanismo e somam dois controladores a um nó pequeno. O backup entra na fase 7.
- **Segredos no Git desde já (Sealed Secrets ou SOPS):** num cluster local recriado a cada teste, a chave de selagem mudaria a cada vez.

## Consequências

- `pnpm k8s:up`, `k8s:smoke`, `k8s:obs` e `k8s:obs-check` sobem e conferem tudo, e o job `k8s` do CI faz o mesmo num k3d no runner.
- Um único nó, um único Postgres e um único RabbitMQ: não há alta disponibilidade, como o escopo da v1 aceita.
- A pausa das NetworkPolicies em pods novos é uma peculiaridade do k3s, coberta pelos _init containers_ e pelas tentativas dos processos longos.
