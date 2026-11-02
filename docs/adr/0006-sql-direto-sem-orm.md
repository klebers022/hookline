# ADR 0006: SQL direto, sem ORM

**Status:** aceita

## Contexto

As garantias do Hookline dependem de recursos específicos do PostgreSQL, como transações, `FOR UPDATE SKIP LOCKED` e índices parciais. O projeto também existe para demonstrar esses conceitos.

## Decisão

Usar o driver `pg` com SQL escrito à mão e migrações em SQL com `node-pg-migrate`.

## Consequências

- As consultas e as transações ficam explícitas, fáceis de ler e de analisar com `EXPLAIN`.
- Parâmetros `$1` evitam SQL injection, mas os tipos das linhas são declarados manualmente e não são verificados contra o banco.
- Há mais código repetitivo em consultas simples. Isso é aceitável com poucas tabelas, mas um query builder pode ser reavaliado se o projeto crescer.
