# ADR 0007: PostgreSQL próprio em vez de Supabase ou Neon

**Status:** aceita

## Contexto

O Hookline precisa de um banco relacional com transações, `FOR UPDATE SKIP LOCKED` e índices parciais. O projeto precisa ser gratuito e rodar inteiro na máquina de desenvolvimento e numa única VPS Oracle. Supabase e Neon oferecem PostgreSQL gerenciado com plano gratuito.

## Decisão

Rodar o PostgreSQL próprio: em contêiner no desenvolvimento, pelo Docker Compose, e no cluster da VPS em produção. As migrações são aplicadas pelo próprio projeto, com `node-pg-migrate`.

## Alternativas consideradas

- **Supabase:** traz autenticação, API automática e painel, que o Hookline não usaria. O plano gratuito pausa projetos inativos e limita conexões e armazenamento.
- **Neon:** separa armazenamento e processamento e desliga o banco ocioso. A primeira consulta após a pausa fica lenta, o que atrapalha o relay e o worker, que consultam o banco o tempo todo.
- **SQLite:** não oferece `FOR UPDATE SKIP LOCKED`, que permite vários relays em paralelo, e não serve bem para vários processos gravando ao mesmo tempo.

## Consequências

- O banco fica perto da aplicação, sem latência de rede externa nem limite de conexões de terceiros.
- O ambiente local é igual ao de produção, e os testes de integração usam a mesma imagem (`postgres:17-alpine`).
- Backup, restauração, atualização de versão e monitoramento passam a ser responsabilidade do projeto. A fase 7 inclui backup diário fora da VPS e um teste de restauração.
- Não há alta disponibilidade: se a VPS cair, o banco cai junto. Isso é aceito porque o projeto roda num nó único.
