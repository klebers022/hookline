# ADR 0011: Painel web na mesma origem, com a chave só na memória

**Status:** aceita

## Contexto

Até a fase 4, para saber o que aconteceu com um evento, era preciso chamar a API com `curl` e ler JSON. Para reenviar uma entrega, era preciso achar o ID dela e chamar `POST /v1/deliveries/:id/retry` na mão. A fase 5 entrega um painel em que um evento com falha é diagnosticado e reenviado pelo navegador.

A demo não tem cadastro nem usuários: um projeto é criado por script, e a única credencial é a API key do projeto. O painel vai rodar no Kubernetes (fase 6) e numa VPS com HTTPS (fase 7).

## Decisão

**React, Vite, TanStack Query, React Router e Tailwind em `apps/web`.** O TanStack Query cuida do cache, da paginação por cursor ("Carregar mais") e da atualização automática. Os detalhes de algo que ainda não terminou buscam de novo a cada 3 s e param quando a entrega chega a `succeeded` ou `dead`.

**Mesma origem, sem CORS.** O painel chama `/v1/...` no próprio endereço. No desenvolvimento, o proxy do Vite repassa `/v1` para a API. Na imagem `hookline-web`, o nginx serve os arquivos e repassa `/v1` para `API_URL`. A API continua sem cabeçalhos CORS, então nenhum outro site consegue usá-la a partir do navegador de alguém.

**A API key fica só na memória da aba.** Ela fica num estado do React, nunca em `localStorage`, `sessionStorage` ou cookie. Recarregar a página pede a chave de novo, e um `401` em qualquer chamada volta para a tela de entrada. Cada sessão tem o próprio cache de consultas, então nada de um projeto aparece sob a chave de outro.

**Imagem própria com nginx sem root.**

- Usa `nginx-unprivileged` (alpine, porta 8080), fixado por digest. O `dist/` do Vite é igual em todas as arquiteturas, então o multi-arch sai da mesma cópia da ADR 0009.
- Fallback da SPA para o `index.html`, que é revalidado a cada visita. Os arquivos com hash no nome ficam em cache por um ano.
- CSP sem `unsafe-inline` (`default-src 'self'`, `frame-ancestors 'none'`), `nosniff` e `Referrer-Policy: no-referrer`.

**Tipos das respostas escritos à mão** em `apps/web/src/api/types.ts`. As rotas validam a entrada, mas não declaram schema de resposta, então o OpenAPI gerado não tem os tipos de saída. O teste Playwright roda contra a API real e pega uma divergência que importe.

**Teste de ponta a ponta com Playwright no job `infra` do CI**, contra a stack em contêineres e com `RETRY_DELAYS` de 1 s:

1. Uma entrega falha e o destino é desativado.
2. O teste entra no painel, acha a entrega em "Failed" e lê as tentativas com status 500.
3. Reativa o destino pelo painel e clica "Retry".
4. Vê a entrega chegar a `succeeded` sem recarregar a página.

Um segundo teste confere que recarregar a página esquece a chave e que nada fica salvo no navegador.

## Alternativas consideradas

- **Servir o painel pela própria API** (`@fastify/static`): uma imagem a menos, mas a API passaria a servir arquivos, e o painel não poderia escalar nem ser atualizado à parte.
- **Painel em outra origem, com CORS na API:** exigiria liberar a origem do painel na API e configurar dois endereços em cada ambiente.
- **Chave em `sessionStorage`:** sobreviveria ao recarregar, mas ficaria ao alcance de qualquer script injetado durante a sessão. Para uma demo, digitar a chave de novo custa pouco.
- **Login com usuário e senha, e um cookie `HttpOnly`:** é o modelo certo para vários usuários, mas exige cadastro, sessões e proteção contra CSRF, que estão fora da v1.
- **Tipos gerados do OpenAPI** (`openapi-typescript`): exigem antes declarar o schema de resposta de todas as rotas. Fica como evolução; os schemas também acelerariam a serialização no Fastify.

## Consequências

- Quem tem a chave tem acesso total ao projeto pelo painel, como já tinha pela API. Não há permissões por usuário.
- Recarregar a página ou abrir outra aba pede a chave de novo.
- A atualização automática conta no rate limit do projeto: uma tela aberta faz até 20 pedidos por minuto enquanto houver entrega em andamento.
- Uma mudança no formato das respostas da API precisa ser repetida em `types.ts`. O `tsc` não avisa; o Playwright avisa só no que ele percorre.
- A imagem do nginx é reconstruída com menos frequência do que o Alpine corrige pacotes, então o build roda `apk upgrade` (e remove o `curl`, que não é usado). Isso deixa o build menos reprodutível: duas construções do mesmo commit podem ter versões diferentes de pacotes do Alpine.
- A pasta `apps/web/dist` vai para a imagem `hookline-web`. O `pnpm build` da raiz passa a compilar o painel também.
