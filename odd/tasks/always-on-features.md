# Always-on features

Remove runtime feature flags so every chatbot capability is always active in production.
Branch: `feat/always-on-features`. Production has no real users (owner, 2026-11-05).

## Specs

- S1. Owner: "ya no quiero estar teniendo miles de variables de entorno para prender/apagar funcionalidades en produccion, ahora en producion no hay nadie usando el chatbot real, por lo que no importa del todo esto, quiero tener todo prendido, ya se que hay cosas que no estan probadas o no estan terminadas, estoy consiente de ello, y es por eso que no importa si esta prendido o apagado, solo agrega muchas friccion para probar funcionalidades"
- S2. A removed flag is removed from env validation, configuration, preflight posture checks and docs; the code path it guarded runs unconditionally and the alternative path it disabled is deleted.
- S3. Configuration that a now-always-on feature needs (credentials, migrations) becomes required or is derived, so a missing value fails at startup instead of silently disabling the feature.
- S4. Owner: "ESTE SISTEMA AUN NO ESTA EN USO EN PRODUCICON REAL, es por eso que no importa lo que cambiemos ahora, no importa lo que quitemos/agreguemos" — no backward compatibility for removed env vars.

## Tasks

- T1 [S1-S4] Human decisions always on: HUMAN_HANDOFF_ENABLED, HUMAN_DECISIONS_RESTOCK_ENABLED, HUMAN_DECISIONS_EXPIRATION_ENABLED, HUMAN_DECISIONS_CUSTOMER_INBOUND_ENABLED. Route: inline. Commit: —
- T2 [S1-S4] Atomic checkout always on (MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED); delete the legacy POST /sales order path. Route: inline. Commit: —
- T3 [S1-S4] Minimal route always on: MINIMAL_CATALOG_AGENT_ENABLED, MINIMAL_CATALOG_ORDER_ENABLED, MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS (blocked: owner decision on real number). Route: inline. Commit: —
- T4 [S1-S3] Receipt metrics: drop RECEIPT_MEDIA_METRICS_ENABLED. Route: inline. Commit: —
- T5 [S1-S3] Shipping flags (blocked: owner decision on moving carriers to backend). Commit: —
- T6 [S1-S3] Receipt media flags (blocked: receipt image storage decision). Commit: —
- T7 [S2] Preflight posture and docs cleanup. Route: inline. Commit: —

## Log

- L1 (2026-11-05, owner, verbatim excerpt): "en primera quiero YA configurar el numero real, en segunda, por favor, ya no quiero estar teniendo miles de variables de entorno para prender/apagar funcionalidades en produccion, ahora en producion no hay nadie usando el chatbot real, por lo que no importa del todo esto, quiero tener todo prendido, ya se que hay cosas que no estan probadas o no estan terminadas, estoy consiente de ello, y es por eso que no importa si esta prendido o apagado, solo agrega muchas friccion para probar funcionalidades y ademas no es nada comodo para mi"
- L2 (2026-11-05): Backend inventory (main 6b8f99c) confirms /chatbot-api/checkouts and /checkouts/status exist; the preflight note "atomic checkout is not deployed yet" is stale.
- L3 (2026-11-05): Flag map from explorer: shipping ON requires Skydropx credentials and makes every order require a human-approved quote; receipt media ON requires Spaces/S3 storage, public base URL and capability keys; legacy AgentRunner still serves the ops synthetic turn.
