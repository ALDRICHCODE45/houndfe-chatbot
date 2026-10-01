# Human decisions v1: EXPIRATION (agreed integration contract; backend source and bot intake + receipt + HTTP transport only)

**Status:** BUSINESS rules owner-approved; TECHNICAL integration contract agreed by the three repo agents (backend, frontend, bot). Backend source for EXPIRATION intake/receipt is implemented against its own validated source — parent-observed HEAD `cde0f58`; this is source evidence only, **not deployment proof, live routing, or activation**. The frontend is an independent phase and remains pending. The owner authorizes the bot to proceed locally in parallel (no serialization behind a validated backend delivery). Bot-side, the strict intake normalizer (`src/chatbot-api/domain/dtos/human-decisions-expiration.dto.ts`) and its receipt normalizer (`src/chatbot-api/domain/dtos/human-decisions-expiration-receipt.dto.ts`) are implemented locally, and the EXPIRATION HTTP transport method (`submitExpirationIntake` in `src/chatbot-api/infrastructure/chatbot-api-http.client.ts`) is implemented locally but **not wired to runtime**; the GET poll, runtime wiring, E2E compatibility, and activation remain pending. Historical `docs/human-decisions-contract-v1.md` (RESTOCK) is unchanged and authoritative for shared lifecycle shapes; its labels are not proof of current deployment.

## Approved business decisions (owner)

| #   | Decision                                                                                         | Consequence                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| B1  | Subject is product + presentation only; no tracked lot/batch identity.                           | The bot stores no lot id; a human may still explain that units/lots can carry different dates. |
| B2  | Operator answers with brief plain text OR a separate "unavailable" action.                       | Two typed outcomes; the bot invents no estimate.                                               |
| B3  | The customer's explicit expiry question about an identified product authorizes a direct inquiry. | No extra yes/no confirmation and no RESTOCK-style consent gate.                                |
| B4  | While waiting, the customer may keep reading catalog, price, and stock.                          | Read-only browsing stays allowed; no global block.                                             |

B1–B4 are owner-approved. Everything below is the agreed technical integration contract or a proposed sequence — not additional owner policy.

## One safe path

1. The bot binds the inbound sender and current turn to a trusted subject. Inbound proves only the customer's request and sender identity, never authority for arbitrary IDs; `productId`/`variantId` must come from the trusted bot catalog and are never invented. Expiration does **not** require an out-of-stock observation.
2. If the product is ambiguous, the bot asks a clarification question and registers nothing.
3. The bot claims an advisor was contacted only when BOTH the backend intake receipt is confirmed AND the durable local pending association exists. A local intent alone is insufficient. No optimistic notification; a failed intake leaves a retryable local intent, not a false advisor notification.
4. The backend owns a tenant-scoped PENDING decision; a reviewer submits one typed, audited resolution.
5. The bot polls the GET endpoint for current state and revalidates its pending marker, sender, and original subject, then records a delivery attempt and reports a separate outcome.
6. Changing the product the customer is browsing must **not** silently cancel the original inquiry and must **not** rebind the reply. The outgoing copy deterministically names the original product/presentation; revalidation binds the request, not the currently browsed subject.

## Ownership

| Owner    | Authoritative fact                                                                                 | Limit                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Backend  | Decision request, tenant, catalog eligibility check, audited typed resolution, POS                 | Does not know the customer/sender; no transaction with the bot conversation or Meta delivery. |
| Bot      | Sender binding, pending identity, active reservation/collision, revalidation, delivery attempt/ACK | Never exactly-once; never treats a send as device delivery.                                   |
| Frontend | Display and commands only                                                                          | Never derives an action from free text; owns its own POS patterns.                            |

The customer never sees internal IDs (decision id, tenant, reviewer, source request id).

## Facts that must stay separate

`HUMAN_RESOLVED` (a reviewer answered), `PROVIDER_ACCEPTED` (a definite successful provider response with a message ID was observed within the apply window), and device delivery are three different facts. A message ID alone is not acceptance evidence. No exactly-once claim; an ambiguous send is unknown, never a safe automatic retry.

A product-info answer is informational only: it never changes stock, cart, pricing, sale, or payment. "Unavailable" means the HoundFe team could not confirm the information (a human physically checks); it does not mean no internal record exists, and must never be presented as expired, unsafe, or out of stock.

## Agreed wire contract (EXPIRATION)

### Intake

- `POST /chatbot-api/human-decisions` (existing route) with exactly four required keys, no extras: `{sourceRequestId: UUID, type: 'EXPIRATION', productId: UUID, variantId: UUID|null}`.
- `X-Idempotency-Key` is a literal UUID equal to `sourceRequestId`.
- `variantId` is null ONLY when the product has no variants. A variant product requires an explicit owned, visible variant — never auto-select.
- Backend validates tenant and the same bot catalog eligibility (no public-catalog rules; no invented `isActive`/stock requirements).
- Source and tenant are auth-derived; no customer names, phones, or transcripts.

### Snapshot (server-owned, immutable)

`{branchId, branchName: string|null, productId, productName, unit: string, variantId, variantName, variantOption, variantValue}`

- `unit` = `Product.unit` for both simple and variant products; a commercial code, not a consumer enum and not size/content.
- Variant product: `variantName: string` required, `variantOption`/`variantValue` nullable. Simple product: `variantName`/`variantOption`/`variantValue` all null.
- No SKU. `productName` is the original persisted label, not a live lookup.
- The canonical intake hash covers the request identity, not live catalog labels. Replay lookup and payload comparison happen BEFORE current catalog validation; a later rename or unpublish does not alter an exact replay or its historical snapshot.

### Receipt and poll

- `POST` → 201; exact replay → 200, both with `{id, sourceRequestId, type, status: 'PENDING', version: 1, createdAt, snapshot, supersedesDecisionId: null, resolution: null, applyBefore: null}`. This is the immutable historical receipt.
- Only `GET /chatbot-api/human-decisions/:id` returns current state.
- Resolved v2 poll resolution: `{action, expirationText, resolvedAt}` where `action` is `PROVIDE_EXPIRATION_TEXT` (with `expirationText`) or `REPORT_EXPIRATION_UNAVAILABLE` (no `expirationText`); `applyBefore = resolvedAt + 24h`. No `resolvedBy` in the bot projection.

### POS

- Existing GET list/detail and POST resolve; mixed types preserve the RESTOCK type.
- Agreed new payload fields only: `action`/`expirationText` plus `expectedVersion`/`resolutionRequestId`. Do not invent a POS `resolvedBy` projection; the frontend reuses existing POS RBAC/CAS/current patterns.
- UI shows "Respuesta registrada"; no ACK display.

### ACK

- `POST /chatbot-api/human-decisions/:id/application-outcome` (existing route).
- Existing flat body: `{attemptId, expectedResolutionVersion: 2, outcome, providerMessageId?, providerAcceptedObservedAt?, attemptedAt?, evidenceCode?}`; there is no new nested `evidence` field. Outcomes `PROVIDER_ACCEPTED` / `PROVIDER_ACCEPTED_LATE` / `DELIVERY_UNKNOWN` / `STALE` retain RESTOCK evidence requirements with the type-aware 24h window.
- Success 200: `{id, version: 2, attemptId, outcome, ackReceivedAt}`.
- Reference `docs/human-decisions-contract-v1.md` for the existing evidence semantics; do not redefine them here.

## Freshness and failure (owner-approved 24h)

- Owner-approved resolution freshness: `applyBefore = resolvedAt + 24h` for BOTH outcomes. This is distinct from the WhatsApp 24-hour service window (which counts from the customer's last inbound).
- The half-open interval `[resolvedAt, applyBefore)` governs BOTH when a send may start AND when provider acceptance must be observed — not the attempt alone.
- After the deadline: record STALE only if a send definitely never started; `DELIVERY_UNKNOWN` / `PROVIDER_ACCEPTED_LATE` are held with no automatic retry.
- Template eligibility is a separate concern and cannot bypass a stale window.
- The local reservation closes only after the appropriate durable outcome/ACK; UNKNOWN/LATE never auto-close or auto-retry. After a definite STALE with a durable ACK and local closure, an actual NEW customer inquiry may create a NEW `sourceRequestId` (no `supersedes` field); never reopen or reuse an old ID, and an ACK never creates a new request automatically.

## Text policy (technical agreement, not an owner choice)

- Length 1..500 UTF-16 units measured by normalized JS `length`.
- Order: NFC → reject C0/C1/DEL including tabs/newlines → collapse other whitespace + trim → validate bounds. Reject overflow; never silently truncate.
- Human text is plain, untrusted, never executed, and never sent through the LLM for interpretation. It is wrapped truthfully as coming from the HoundFe team.
- Guide the operator to use concrete dates as a human knows them (e.g. an explicit month/year); no date parser and no invented date.
- Relative expressions are not semantically validated: preserve content; the bot does not normalize or infer.

## Errors (agreed envelope `{statusCode, code, message}`)

- `400 VALIDATION_ERROR` for bad shapes, including `variantId` null on a variant product or a `variantId` set on a simple product.
- `404 NOT_FOUND` for a foreign, missing, or not-bot-consultable catalog product.
- `409 IDEMPOTENCY_CONFLICT` for a mismatched payload under the same key.
- Do not claim auth errors changed; reference the existing policy.

## Reuse concern: type-specific vs genuinely reusable

The local contract is RESTOCK-only: `RestockIntakeInput.type` is `'RESTOCK'`, `ReservationRoute` is `'LEGACY_OPS' | 'RESTOCK'`, and the reservation store validates payloads with `normalizeRestockIntake`. Changing only a discriminator does not make the existing schema, reservation, or runtime accept a generic type. Reusable: the lifecycle shape (reserve → durable pending → audited typed resolution → poll/revalidate → separate delivery outcome). Not interchangeable: the payloads. Each repo validates its own extension and owns its internal patterns.

## Boundaries and non-goals

- Source/tenant are auth-derived; no customer names, phones, or transcripts in the decision.
- The bot owns the active reservation collision/closure; the backend does not know the customer/sender. `sourceRequestId` alone does not prevent two fresh parallel IDs — the bot reservation guards the active one.
- No new async engine, registry, or plugin abstraction is proposed.
- In scope: this alignment plus the bot's strict intake normalizer, its receipt normalizer, and its HTTP transport method only. Out of scope: runtime writes, cross-repo implementation, activation, and template creation.

## Sequence (owner-approved local order)

1. **Backend:** source implemented (parent-observed HEAD `cde0f58`); not deployment proof, delivered, or activated.
2. **Frontend:** independent phase, still pending; awaits its own validated delivery.
3. **Bot:** owner-authorized to proceed locally in parallel; strict intake and receipt normalizers plus the HTTP transport method (`submitExpirationIntake`, not wired) implemented, with poll/runtime/E2E/activation pending.

No push/deploy/activation/production. These are ordered phases, not a promise of a small (e.g. ≤400-line) full runtime implementation.

## Rehearsal invariants (manual, six cases)

| Case                  | Expected invariant                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Available             | `PROVIDE_EXPIRATION_TEXT` delivered as plain text; stock/cart/pricing/sale/payment unchanged. |
| Unavailable           | Team could not confirm the date; never expired/unsafe/out-of-stock.                           |
| Ambiguous subject     | Clarify before intake; nothing registered.                                                    |
| Duplicate and timeout | No duplicate ops handoff; an ambiguous send is unknown, not auto-retried.                     |
| Pending browse        | Constrained read-only catalog/price/stock continue; no global block.                          |
| Late or collision     | Changed browsing does not cancel/rebind the original inquiry; no concurrent reservation.      |

## References

- `docs/conversation-analysis.md` — R14 (expiry questions escalate to a human).
- `docs/human-decisions-contract-v1.md` — RESTOCK lifecycle and shared ACK/evidence semantics, unchanged.
- `odd/tasks/human-decisions-restock.md` — RESTOCK task tracker, unchanged.

## Remaining checkpoint

Backend source is implemented (parent-observed HEAD `cde0f58`, not deployment proof); the frontend remains pending independently. Bot-side, the HTTP transport method is implemented but not wired; the GET poll, runtime wiring, E2E compatibility, and activation verification remain open. The approved rules above are not to be re-litigated.
