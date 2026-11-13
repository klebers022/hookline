# Entregas na DLQ

**Alerta:** `HooklineDeadLetters` (aviso). Pelo menos uma entrega foi para a DLQ nos últimos 10 minutos.

## O que significa

Uma entrega vai para `dead` e para a DLQ (o setor de não entregues) quando:

- **as 6 tentativas falharam**, ao longo de cerca de 8h36;
- **o prazo do calendário venceu** com o disjuntor do destino aberto (`DEADLINE_EXCEEDED`);
- **o destino respondeu `410 Gone`**, e o Hookline o desativou.

Na maior parte das vezes o problema é do destino do cliente, não do Hookline. Mesmo assim, cada uma merece um olhar: o cliente pode não saber que está perdendo avisos.

## Diagnóstico

1. **Quais entregas e para onde:**

   ```sh
   curl -H "Authorization: Bearer $API_KEY" "http://hookline.localhost:8088/v1/deliveries?status=dead"
   ```

   No painel web, a aba **Failed → Dead** mostra o mesmo, com o motivo de cada uma.

2. **O motivo da última tentativa, agrupado:**

   ```sql
   SELECT e.url, a.response_status, a.error_code, count(*)
   FROM deliveries d
   JOIN endpoints e ON e.id = d.endpoint_id
   JOIN delivery_attempts a
     ON a.delivery_id = d.id AND a.attempt_number = d.attempt_count
   WHERE d.status = 'dead'
   GROUP BY 1, 2, 3
   ORDER BY 4 DESC;
   ```

   | O que aparece                             | Leitura                                                                                               |
   | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
   | `5xx` de um só destino                    | o destino do cliente está com problema                                                                |
   | `TIMEOUT`                                 | o destino demora mais de 10 s para responder                                                          |
   | `410`                                     | o cliente desativou o endpoint de propósito                                                           |
   | `SSRF_BLOCKED`                            | a URL passou a resolver para um IP interno                                                            |
   | `DEADLINE_EXCEEDED`                       | o destino ficou fora o calendário inteiro, com o disjuntor aberto                                     |
   | muitos destinos diferentes ao mesmo tempo | provavelmente o problema é do lado do Hookline: veja [Muitas falhas de entrega](high-failure-rate.md) |

## Ação

- **Destino do cliente com problema:** avise o cliente. Depois que ele corrigir, reenvie pelo painel (botão **Retry**) ou pela API:

  ```sh
  curl -X POST -H "Authorization: Bearer $API_KEY" "http://hookline.localhost:8088/v1/deliveries/<id>/retry"
  ```

  O reenvio dá **uma** tentativa nova. Responde `409` se a entrega não está `dead` ou se o endpoint não está ativo.

- **Endpoint desativado por `410`:** só o cliente decide reativá-lo (`PATCH /v1/endpoints/:id` com `"status": "active"`).
- **Problema do Hookline:** resolva a causa primeiro e depois reenvie.

## Confirmação

As entregas reenviadas aparecem como `succeeded`. A profundidade da DLQ não diminui, e isso é esperado: a mensagem antiga fica lá até o TTL de 30 dias, e o número certo de entregas `dead` vem do banco (ADR 5).
