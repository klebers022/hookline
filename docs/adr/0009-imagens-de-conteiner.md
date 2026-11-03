# ADR 0009: Imagens de contêiner compiladas, sem root e multi-arch por cópia

**Status:** aceita

## Contexto

A API, o relay, o worker de entrega e o receptor de teste precisam rodar em Docker Compose, no Kubernetes (fase 6) e numa VPS ARM (Oracle Ampere A1, fase 7). Durante o desenvolvimento, eles rodam TypeScript direto pelo `tsx`. O encerramento gracioso (ADR 0004 e fase 2) só funciona se o `SIGTERM` do `docker stop` chegar ao processo do Node.

## Decisão

**Compilar com `tsc`.** Cada pacote exporta o `dist/` por padrão e o `src/` sob a condição `@hookline/source`, usada pelo `tsx`, pelo `tsc` e pelo Vitest. A imagem roda `node dist/...` sem `tsx` nem `esbuild`.

**Um `Dockerfile` multi-stage.** Um estágio instala, compila e monta cada app com `pnpm deploy --prod`, que deixa só o `dist/` e as dependências de produção. Há um alvo por imagem: `api` (que também roda as migrações), `worker` (carteiro por padrão, relay por comando) e `test-receiver`.

**Imagem final mínima.** Base `node:24-alpine` fixada por digest, sem npm, npx, corepack e yarn, com `USER node`. O `CMD` em formato exec deixa o `node` como processo 1, recebendo o `SIGTERM`.

**Multi-arch por cópia.** O estágio de build roda na arquitetura da máquina (`--platform=$BUILDPLATFORM`). Como nenhuma dependência de produção tem código nativo, a mesma pasta serve para `amd64` e `arm64`. Sob emulação, só rodam a remoção dos gerenciadores de pacote e as cópias.

**Varredura antes de publicar.** O workflow `images.yml` constrói cada imagem em `amd64` e roda o Trivy, que falha com vulnerabilidade `CRITICAL` ou `HIGH` que já tenha correção. Em PR, para aí. Na `main` e em tags `v*`, envia o relatório completo para a aba Security e publica `amd64` + `arm64` no GHCR com as tags `sha-<commit>`, `main` e a versão. O Dependabot atualiza o digest da base, as actions (fixadas por SHA) e os pacotes npm.

## Alternativas consideradas

- **`tsx` em produção:** dispensaria a compilação, mas levaria `esbuild`, que tem binário por arquitetura, e transpilaria a cada início.
- **Bundle com esbuild:** geraria um arquivo só, mas quebraria o caminho das migrações e os arquivos estáticos do Swagger UI, que são lidos do disco.
- **Distroless:** teria ainda menos arquivos, mas não tem shell para depurar, e o Alpine já sai sem vulnerabilidades altas.
- **Compilar sob QEMU ou em runners ARM:** o primeiro leva minutos, e o segundo exige juntar os manifestos de dois jobs. A cópia dá o mesmo resultado.
- **Varrer depois de publicar:** uma imagem vulnerável chegaria ao registro antes de ser barrada.

## Consequências

- Uma dependência nativa futura quebraria a cópia entre arquiteturas, e o build dela teria de rodar sob emulação.
- A remoção do npm acontece numa camada nova, então a imagem não diminui de tamanho; só os arquivos somem do sistema final que o Trivy analisa.
- A imagem `arm64` não é varrida à parte. As dependências npm são as mesmas, e os pacotes do Alpine vêm da mesma versão.
- O GHCR cria os pacotes como privados. Torná-los públicos é uma configuração manual da conta.
