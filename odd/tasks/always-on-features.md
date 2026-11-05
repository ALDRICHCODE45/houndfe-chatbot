# Always-on features

Remove runtime feature flags so every chatbot capability is always active in production.
Branch: `feat/always-on-features`. Production has no real users (owner, 2026-11-05).

## Specs

- S1. Owner: "ya no quiero estar teniendo miles de variables de entorno para prender/apagar funcionalidades en produccion, ahora en producion no hay nadie usando el chatbot real, por lo que no importa del todo esto, quiero tener todo prendido, ya se que hay cosas que no estan probadas o no estan terminadas, estoy consiente de ello, y es por eso que no importa si esta prendido o apagado, solo agrega muchas friccion para probar funcionalidades"
- S2. A removed flag is removed from env validation, configuration, preflight posture checks and docs; the code path it guarded runs unconditionally and the alternative path it disabled is deleted.
- S3. Configuration that a now-always-on feature needs (credentials, migrations) becomes required or is derived, so a missing value fails at startup instead of silently disabling the feature.
- S4. Owner: "ESTE SISTEMA AUN NO ESTA EN USO EN PRODUCICON REAL, es por eso que no importa lo que cambiemos ahora, no importa lo que quitemos/agreguemos" — no backward compatibility for removed env vars.

## Tasks

- T1 [S1-S4] Human decisions always on: HUMAN_HANDOFF_ENABLED, HUMAN_DECISIONS_RESTOCK_ENABLED, HUMAN_DECISIONS_EXPIRATION_ENABLED, HUMAN_DECISIONS_CUSTOMER_INBOUND_ENABLED. Route: gentle-ai-worker. Commit: 6ef762f (slice 1; mostly deletions, 350+/858-).
- T2 [S1-S4] Atomic checkout always on (MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED); delete the legacy POST /sales order path. Route: gentle-ai-worker. Commit: d75b7ea (slice 2).
- T3 [S1-S4] Minimal route always on: MINIMAL_CATALOG_AGENT_ENABLED, MINIMAL_CATALOG_ORDER_ENABLED, MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS (owner: new dedicated number, serve every sender). Route: gentle-ai-worker. Commit: 9043896 (slice 3).
- T4 [S1-S3] Receipt metrics: drop RECEIPT_MEDIA_METRICS_ENABLED. Route: inline. Commit: —
- T5 [S1-S3] Shipping flags (blocked: owner moved carriers to backend; replace chatbot Skydropx once the backend quote endpoint exists). Commit: —
- T6 [S1-S3] Receipt media flags (blocked: receipt image storage decision). Commit: —
- T7 [S2] Preflight posture and docs cleanup. Route: inline. Commit: —

## Log

- L1 (2026-11-05, owner, verbatim excerpt): "en primera quiero YA configurar el numero real, en segunda, por favor, ya no quiero estar teniendo miles de variables de entorno para prender/apagar funcionalidades en produccion, ahora en producion no hay nadie usando el chatbot real, por lo que no importa del todo esto, quiero tener todo prendido, ya se que hay cosas que no estan probadas o no estan terminadas, estoy consiente de ello, y es por eso que no importa si esta prendido o apagado, solo agrega muchas friccion para probar funcionalidades y ademas no es nada comodo para mi"
- L2 (2026-11-05): Backend inventory (main 6b8f99c) confirms /chatbot-api/checkouts and /checkouts/status exist; the preflight note "atomic checkout is not deployed yet" is stale.
- L3 (2026-11-05): Flag map from explorer: shipping ON requires Skydropx credentials and makes every order require a human-approved quote; receipt media ON requires Spaces/S3 storage, public base URL and capability keys; legacy AgentRunner still serves the ops synthetic turn.
- L4 (2026-11-05): T1 done in 6ef762f. Leftovers for T7: dead service-level `enabled` fields (MinimalRestockRequestService, MinimalExpirationRequestService deps, tool-deps restock.enabled, request-human-assistance.tool); docs/meta-test-sandbox-setup.md still says not to create OPS_CHANNEL_PHONE. Webhook now returns 500 when RESTOCK or customer-inbound capture fails (DB dependency on every message).
- L5 (2026-11-05, owner, verbatim): "1. Numero nuevo real para el chatbot, no el numero de prueba de meta. 2. Envios perros y skydropx son las dos opciones que hoy se ocupan como envios con externos, se usa la que sea mas barata, punto y no, no tengo conexion a su api. 3. Si lo recomiendas si."
- L6 (2026-11-05): T2 done in d75b7ea. Leftovers for T7: new_address_unsupported reply wording now only for saved address without customer id; GET /customers/checkout-context missing from CLIENT_ROUTES.
- L7 (2026-11-05): T3 done in 9043896. Leftovers for T7: docs/minimal-cart.md line 3 says the agent cannot create orders; test/demo sandbox e2e (`jest --config ./test/jest-e2e.json test/demo`) fails resolving RestockInboundCapture, likely pre-existing since T1 made captures required; odd/tasks history files still mention removed flags (intentional).
