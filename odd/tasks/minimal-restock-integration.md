# WU-B: minimal RESTOCK confirmation wiring (default-off, local)

**Auth:** owner-approved LOCAL additive. No commits/push/deploy; no backend/DB/Meta/Docker/secrets/`.env`/deps. Single writer.

**Flags (read from `src/config/configuration.ts`):** minimal-route RESTOCK needs BOTH `MINIMAL_CATALOG_AGENT_ENABLED=true` with an allowlisted sender AND `HUMAN_DECISIONS_RESTOCK_ENABLED=true` (exact string). With the minimal route active, RESTOCK off preserves its read-only behavior. Minimal disabled or non-allowlisted senders follow the unchanged legacy dispatcher; that legacy route has its own capabilities. No controller/registry/schema/DI cycle added.

**Flow:** trusted inbound tuple (`receivingPhoneNumberId`/`senderId`/`messageId`) → `prepareRestock` (non-mutating; the server validates stock and the canonical variant) → the server asks SÍ/NO → the customer's strict new-message SÍ is the ONLY consent → exactly one existing `runRestockRoute`. `onSent` arms only after a successful Meta send; a failed initial send re-exposes a checked `onSent` on the origin-question replay.

**Gates/TTL:** one pending per sender, 5-minute TTL, RAM-only (restart loses consent, never authorizes a write). At most one preparation per SDK run; the model never supplies consent/name/sender/message. Declined or untrusted confirmation cannot write. An enabled minimal RESTOCK attempt never falls back to legacy handoff.

**Poller:** `RestockApplicationPoller` keeps process-local watches (`maxTrackedKeys=100`, `maxPolls=17280` @5s ≈ 24h). Shutdown drops waiting jobs with no startup recovery of those watches; the existing durable intake/application ledgers are separate. Do not promise an eventual WhatsApp notification.

**Credential scope:** `POST /chatbot-api/human-decisions` requires `human-decisions:create` (the poller reads `human-decisions:read`, ACKs `human-decisions:ack`). Idempotency `X-Idempotency-Key == sourceRequestId`; the domain client is already correct — no API change.

**Scope tests:** `minimal-restock-request.service.spec.ts`, `minimal-catalog-agent.service.spec.ts`, `llm-agent.module.spec.ts`, `webhook-dispatcher.service.spec.ts`. No production claims.

**Runbook (peer-reported, runtime UNVERIFIED):** frontend peer (readonly) confirms the source route Chatbot→Solicitudes at `/pos/decisiones-pendientes` (`read:HumanDecision` to view, `update:HumanDecision` to resolve). Backend peer confirms svc permissions `human-decisions:create` (POST `/chatbot-api/human-decisions`), `human-decisions:read` (GET `/:id`), `human-decisions:ack` (POST `/:id/application-outcome`). Actual credentials/scopes/roles, migration `20260925000100_human_decisions_restock`, and the UI deployment are UNVERIFIED. The existing POST does NOT recheck stock (preflight is fresh but the TOCTOU race already exists); do not change the backend. No push/deploy/commit was done.
