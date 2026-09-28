# WU-A: minimal RESTOCK confirmation gate (default-off, local)

**Auth:** owner-approved LOCAL additive. No commits/push/deploy; no backend/DB/Meta/Docker/secrets/`.env`/deps. The original ADD forecast 300–380 with a <400 hard stop was MISSED and is NOT claimed met; the parent disclosed the estimate was wrong, revised the ceiling to 800 TOTAL ADD+DEL, and authorized these surgical corrections prospectively (not retroactive approval).

**Scope:** new plain `MinimalRestockRequestService` (`src/llm-agent/application/`) + a minimal export of the EXISTING private `runRestockRoute` (`Pick<ToolDeps,'store'|'chatbotApi'>` only; body/preflight/coordinator/recovery/fail-closed unchanged) + a visibility-only export of the EXISTING `DISPLAY_BREAKING` (`catalog-references.ts`, no regex/legacy change). No tool loop/registry/cart/sales/handoff/SDK dispatch wiring (WU-B). Files: service, spec, tool, catalog-references, this doc.

**API (unchanged for WU-B):** `new MinimalRestockRequestService({chatbotApi,store,restock?,clock?})`; `enabled` iff `restock?.enabled===true`. `prepare({senderId,inboundEvent,allowedProductIds,productId,variantId?})→{kind:'offer',reply,onSent}|{kind:'closed'}`; `consume({senderId,text,inboundEvent?})→{kind:'handled',reply}|null`.

**prepare:** gate + `bindRestockInboundEvent` + allowlist + fresh `getStock` proving the canonical subject `out_of_stock`/quantity 0 (explicit depleted variant when variants exist); label from the trusted GET only via an ephemeral `CatalogSession` `installSearch`/`resolve`; never writes; asks SÍ/NO with no ETA/reservation.

- Label bounds corrected: the whole-catalog renderer gate is REMOVED, so one exact variant out of >6 (e.g. 7) now offers; the final label still fails closed on a repeated-name collision, on display-breaking control chars (`DISPLAY_BREAKING`) and beyond 2048 UTF-8 bytes; option/value is included to distinguish repeated names.
- Label alias fix (BLOCKER): `presentationLabel` now compares the SELECTED final rendered label against ALL other variants' rendered labels (shared `renderVariant`), so a unique raw name that renders like a repeated name plus detail, and two option/value tuples that join identically, both fail closed; unselected variants aliasing each other do not by themselves disqualify a distinct selection. TDD: RED = 2 failed/28 passed (both ambiguous IDs of each case offered an aliased label); GREEN = 30/30 service, plus 103/103 catalog/tool = 133 focused, 0 regressions.
- consume: strict `parseShippingCustomerDecision`; BOTH SÍ and NO pass the trusted fresh-turn gate (bound sender + matching channel + non-replay + unexpired + armed). An untrusted/unbound/mismatched/replayed/unarmed verdict never drops the pending and never claims decline/consent; unrelated text clears only on a trusted fresh turn and never returns the ambiguous receipt; expiry clears without a write. Pending one/sender, 5-min TTL, RAM-only, armed via `onSent` after transport, deleted BEFORE the `runRestockRoute` await.

**TDD:** RED (original) stub prepare→closed/consume→null = 14 failed/93 passed. RED (corrections) = 3 failed/24 passed. GREEN = 111/111 (2 suites: service 27 + existing tool 84, unchanged). Boundary via spies; real preflight/coordinator in `request-human-assistance.tool.spec.ts`.

**Limits:** RAM-only pending → daemon restart drops it (accepted); notification poller out of scope; the user has NOT authorized production access; no Meta/backend/real write.

**Budget:** the original <400 hard stop was MISSED and is not claimed met. Parent revised the ceiling to 800 TOTAL ADD+DEL for these corrections. Final authored total = 769 (service 284 + spec 456 + doc 18 + tool 7+2 + catalog 1+1), inside 800.
