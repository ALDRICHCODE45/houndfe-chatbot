# Human intervention — chatbot prerequisites

Chatbot-side prerequisites for the in-system human intervention program (contract v1, backend §10.1/§11). Branch `feat/human-intervention-bot-prereqs`.
Product design: `docs/intervencion-humana-diseno.md`. Chatbot contract excerpt: `docs/contracts/human-intervention-v1.md`. Backend contract: `houndfe-backend/docs/proposals/human-intervention-backend-proposal.md` (branch `docs/human-intervention-proposal`, commit b2fe56af). These are conditions for backend units 5, 9 and 11; backend endpoints do not exist yet, so anything that calls them goes behind a port.

## Specs

- S1 — Durable transcript. Persist every customer inbound message and every bot outbound message (WhatsApp message id, direction, type, text, media reference when present, Meta provider timestamp, bot observation time in ISO-8601 UTC with ms and Z) in the chatbot database, deduplicated by WhatsApp message id, with a purge-after of 12 months. Contract: "El espejo arranca con los mensajes nuevos; no hay backfill posible." Owner: "A los 12 meses se borra solo la conversación (mensajes y medios)."
- S2 — Backend outbox. "Nueva `backend_outbox` con `seq` por conversación, reclamo del menor `seq` pendiente con `SKIP LOCKED`, clave de idempotencia por fila y reintentos indefinidos con backoff. Lleva el espejo, los wamid salientes, statuses, creaciones, cancelaciones y ACKs de sesión." Delivery goes through a port; the HTTP adapter is wired when backend unit 5 exists.
- S3 — Meta statuses. "Se agrega un normalizador que los manda por el outbox, por wamid." Today statuses are parsed by the DTO and dropped (`webhook-dispatcher.service.ts:597`).
- S4 — Durable conversation gates. "compuertas de conversación durables (hoy las de 5 min viven en memoria)": order confirmation, checkout confirmation, address references, pending restock question, expiration session must survive a restart with the same 5-minute expiry.
- S5 — Several open human requests per customer. "Un índice único parcial permite una sola reserva humana ACTIVE por remitente. Hay que reemplazarlo para tener varias solicitudes abiertas por cliente." (`2300000000000_human_decision_reservations.js`).
- S6 — `processed_webhook_messages`: "nunca se purga y se escribe recién después de responder." Add a purge and record the message before replying, without losing a customer message on crash.
- S7 — Handoff mode. "`conversation_state.data.handoff = {mode, epoch, requestId}` con escrituras CAS. El chequeo corre en el dispatcher, antes del LLM." In HUMAN mode the bot never calls the LLM for that conversation; stale epochs are ignored.

## Tasks

| ID  | Specs | Route                                                 | Commit  |
| --- | ----- | ----------------------------------------------------- | ------- |
| T1  | S1    | worker: durable transcript                            | 2fa42a4 |
| T2  | S2    | worker: backend outbox + drain worker behind a port   | 7025ded |
| T3  | S3    | worker: statuses normalizer into outbox               | b615d10 |
| T4  | S7    | worker: handoff mode with CAS + dispatcher gate       | 741b6b7 |
| T5  | S5    | worker: replace one-active-reservation index          | a7a75da |
| T6  | S6    | worker: processed_webhook_messages purge and ordering | e2acd7c |
| T7  | S4    | worker: durable conversation gates                    | 9d33f36 |
| T8  | all   | full suite + verify                                   | fbc3e62 |

## Log

- L1 — Owner, 2026-11-09, after the design: "Si hermano, me parece bien, y el backend tambien puede tener inferencia en el cierre del contrato o en el cierre de las desiciones que se tomen antes de iniciar a implementar, aun no sabemos lo que necesite el backend o que es lo que proponga para el tema de la conversacion completa con el humano, esa parte hay que disenarla muy bien para poder hacer algo que aguante y que sea seguro. por lo demas, adelante, coordinense cuando queiran."
- L2 — 2026-11-10: contract v1 closed by backend (b2fe56af); chatbot confirmed reconciliation (unit 0). Owner on current-code risks (via backend): "hay que tnerlos bien encuenta y muy presentes, porque si o si esto debe ser optimo y con un buen performance."
- L3 — 2026-11-10: T1–T7 committed (2fa42a4, 7025ded, b615d10, 741b6b7, a7a75da, e2acd7c, 9d33f36). Pre-existing Docker specs that rolled back "one step" assumed their migration was last; fixed to roll back by count (outbox in b615d10, 03fc762 receipt-media, 19954be customer-profile). Full suite with RUN_DOCKER_TESTS=1: 330 suites, 8476 passed, 23 skipped, 0 failed. Preflight requires migrations 3800, 3900, 4000, 4100, 4200. Follow-ups: restock open-limit customer wording (sale-flow), legacy pendingHumanRequest still blocks restock until the ops channel is retired, backend to confirm epoch increments on every claim.
- L4 — 2026-11-10: independent verify (gentle-ai-verify): no blockers; D1 (ops reply resumed a customer turn without the HUMAN check), D2 (proactive notices ignored HUMAN mode), W1, W2, W5 fixed in ce51987 and fbc3e62 (holds wired into expiration, restock, delivery-zone and receipt notices; fail closed; no attempt consumed). Remaining low warnings accepted and documented: at-least-once duplicate reply on crash after send (W3), cross-process gate put/delete ordering (W4, consent stays safe). Full suite with RUN_DOCKER_TESTS=1 at fbc3e62: 334 suites, 8520 passed, 23 skipped, 0 failed. Native review assess: high (reviewDue); the branch is too large for one review, so the native review should run per work-unit commit (T4 741b6b7, T6 e2acd7c first) under the owner's consent.
