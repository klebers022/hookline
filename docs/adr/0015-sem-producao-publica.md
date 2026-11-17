# ADR 0015: Sem produção pública; a demonstração roda no k3d

**Status:** aceita

## Contexto

O plano previa uma fase 7 de produção numa VPS Oracle Cloud Ampere A1 (4 núcleos ARM e 24 GB, na cota gratuita), com:

- Terraform;
- k3s de nó único;
- TLS com Let's Encrypt;
- Sealed Secrets;
- backup no Object Storage;
- deploy pelo Argo CD a partir da `main`.

Não foi possível provisionar a instância, e a alternativa seria pagar por uma, fora do orçamento de um projeto de portfólio.

## Decisão

**O Hookline fica como projeto de portfólio, sem endereço público.** A demonstração roda no k3d, que é o mesmo k3s da VPS dentro do Docker, com os mesmos manifestos:

- `pnpm k8s:up` sobe a stack inteira;
- `pnpm chaos` prova a garantia de entrega sob falhas (`docs/chaos.md`);
- o vídeo de `docs/demo.md` mostra tudo funcionando.

A fase 7 sai do caminho. A fase 8 (caos, runbooks, backup e portfólio) foi feita no k3d.

## O que a fase 7 teria trazido, e onde isso está

| Item da fase 7                                       | Situação                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| VPS e k3s de nó único                                | **Equivalente local:** o k3d roda o mesmo k3s, fixado na mesma versão (ADR 0012).                                                            |
| Deploy por GitOps a partir da `main`                 | **Feito no cluster local:** Argo CD com imagens fixadas por SHA (ADR 0013).                                                                  |
| Backup diário e restauração testada                  | **Feito no cluster:** `pg_dump` para um armazenamento S3, com restauração testada no CI (ADR 0014). Fora do cluster, só trocando o endpoint. |
| Runbooks e alertas                                   | **Feito:** `docs/runbooks/`, com `runbook_url` em cada alerta.                                                                               |
| Terraform da OCI                                     | **Não feito:** sem conta para aplicar, seria código nunca executado.                                                                         |
| Domínio e TLS (DuckDNS, Let's Encrypt, cert-manager) | **Não feito:** precisa de um endereço público.                                                                                               |
| Sealed Secrets                                       | **Não feito:** sem cluster duradouro, os segredos são gerados a cada `k8s:up` e nunca entram no Git.                                         |
| Alertmanager e avisos (e-mail, Telegram)             | **Não feito:** os alertas aparecem no Prometheus e no Grafana.                                                                               |
| Bump de versão automático (GitHub App)               | **Não feito:** o `pnpm k8s:bump` grava a troca de versão, e o PR é aberto à mão.                                                             |
| Números de capacidade em hardware real               | **Medidos no notebook** (`docs/capacity.md`), com a observabilidade e o k6 na mesma máquina.                                                 |

## Alternativas consideradas

- **Pagar uma VPS ou um Kubernetes gerenciado:** resolveria, mas com custo mensal para um projeto que não tem usuários.
- **Converter a conta da Oracle para pagamento por uso:** dá acesso à A1 com mais facilidade, mas exige cartão e cobra o que passar da cota. Ficou a critério do dono do projeto, que não seguiu por esse caminho.
- **Uma VPS menor (a E2 Micro, com 1 GB):** não comporta Postgres, RabbitMQ, a aplicação e a observabilidade juntos.
- **Escrever o Terraform mesmo sem aplicar:** daria a aparência de uma fase feita, sem nada que provasse que funciona. O critério do projeto é que cada fase termine com algo demonstrável.

## Consequências

- Quem avalia roda tudo na própria máquina com Docker, `k3d` e `kubectl`, em poucos minutos.
- Nada do que está no repositório depende da VPS. Se ela vier, a fase 7 acrescenta um overlay `prod` e o Terraform, sem mudar a base.
- Os limites de nó único continuam (ADR 0012): uma réplica de Postgres e de RabbitMQ, e a cópia do backup no mesmo cluster.
