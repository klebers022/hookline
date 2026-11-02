# ADR 0001: Monorepo com pnpm workspaces

**Status:** aceita

## Contexto

O Hookline tem API, worker, painel e infraestrutura, que compartilham código como assinatura, proteção contra SSRF e topologia de filas. Além disso, é um projeto de portfólio com um único mantenedor, e quem avalia precisa encontrar tudo facilmente.

## Decisão

Usar um único repositório público, com pnpm workspaces e pacotes em `apps/*` e `packages/*`.

## Consequências

- Uma mudança que afeta API, worker e infraestrutura entra em um único PR.
- O pnpm usa dependências estritas, então um pacote só importa o que declara.
- O CI roda sobre o repositório inteiro. Isso é aceitável neste tamanho, mas pode exigir filtros por pacote no futuro.
- Não adotamos Turborepo ou Nx agora: o ganho de cache não compensa outra ferramenta nesta escala.
