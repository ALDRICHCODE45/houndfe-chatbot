# Shipping Quotes (Skydropx) — Operations Runbook

> Tracker: `odd/tasks/shipping-quotes-skydropx.md` (SQ-6A).
> Scope: quote-only shipping foundation with a Skydropx adapter.

Operator guide for the shipping-quotes slice: default-off posture,
configuration names, the human approval gate, the 25 kg rule, the sandbox
smoke plan, offline checks, rollback, and activation blockers.

**Status: not live-ready.** Quotes are default-off, no sandbox smoke has been
run from this unit, and all seven blockers in §10 remain open. Nothing here
authorizes a live provider call or a customer-facing shipping price.

## 1. Current posture (default off)

- `SHIPPING_QUOTES_ENABLED` defaults to `false`. When disabled,
  `ShippingModule.forRoot()` registers no imports, providers, or exports: no
  clients, provider, orchestrator, or `getShippingQuote` tool; the inventory
  stays at twelve.
- The flag is read once at module-metadata build (boot), so it is **not** a
  live toggle — changing it needs a graceful restart/redeploy. It is
  case-sensitive: only the exact lowercase `true` enables quotes.
- No customer-facing shipping amount is produced by the current flow.
- **The launch preflight requires an explicit `false`, which is stricter than
  the runtime default.** At runtime an unset flag is simply "off", which is a
  safe default. The offline launch preflight (`pnpm preflight:launch`,
  `src/preflight/`) is deliberately stricter: `SHIPPING_QUOTES_ENABLED` must be
  present and exactly `false`. An unset or blank value reports `missing`, and
  `true`, `TRUE`, `False`, `' false '`, `1`, or `yes` report `unsafe`; either
  makes the report `ok: false`. This prevents shipping from ever being switched
  on implicitly during a launch.

## 2. Configuration (names only — never paste values)

All values live in the deployment env or a local `.env` that is never
committed. Do not copy secret material into tickets, chat, logs, or docs.

| Env var                             | Default                        | Purpose                                                        |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `SHIPPING_QUOTES_ENABLED`           | `false`                        | Default-off kill-switch; canonical lowercase `true` to enable. |
| `SKYDROPX_BASE_URL`                 | `https://api-pro.skydropx.com` | Provider origin; HTTPS only. See §3.                           |
| `SKYDROPX_CLIENT_ID`                | required when enabled          | OAuth client id (secret-adjacent; never logged).               |
| `SKYDROPX_CLIENT_SECRET`            | required when enabled          | OAuth client secret (never logged or serialized).              |
| `SKYDROPX_ORIGIN_POSTAL_CODE`       | required when enabled          | Exact 5-digit origin postal code.                              |
| `SKYDROPX_ORIGIN_STATE`             | required when enabled          | Origin area level 1 (≤100 chars).                              |
| `SKYDROPX_ORIGIN_MUNICIPALITY`      | required when enabled          | Origin area level 2 (≤100 chars).                              |
| `SKYDROPX_ORIGIN_NEIGHBORHOOD`      | required when enabled          | Origin area level 3 (≤100 chars).                              |
| `SHIPPING_DEMO_PARCEL_PROFILE_JSON` | absent                         | Optional private measured-demo profile JSON; see §4.           |

Joi validation is conditional: provider fields are validated only when
`SHIPPING_QUOTES_ENABLED=true`. A missing/blank credential or origin then
fails boot fast. When disabled, extra provider values are ignored. Provider
values are trimmed; the origin postal code must be exactly five digits.

## 3. Provider origin approval

- The compiled default `https://api-pro.skydropx.com` is a **production**
  endpoint, not evidence of operator approval or a sandbox endpoint.
  `SKYDROPX_BASE_URL` is validated as HTTPS, but its host is not pinned in
  code. Before any smoke, the owner must confirm the actual sandbox endpoint
  and credentials and separately approve the permitted host. Never use the
  production default as a sandbox fallback or point to a proxy, mirror, or
  plain HTTP host.

## 4. Measured demo profile

`SHIPPING_DEMO_PARCEL_PROFILE_JSON` is one private, versioned, exactly-shaped
profile of an observed cart. It is parsed lazily; absent or malformed input
resolves to `null` and never makes boot fatal.

Shape (placeholders only — never invent measurements):

```text
{ version: 1,
  items: [{ productId: "<uuid>", variantId: "<uuid|omit>", quantity: 1,
            measurement: { weightGrams, lengthCm, widthCm, heightCm } }],
  parcel: { weightGrams, lengthCm, widthCm, heightCm } }
```

Rules: version `1`; 1–20 unique item lines; positive whole-number
measurements; parcel weight equals the summed line weights; total ≤ 25,000 g.
The profile matches only the identical cart (same products, variants, and
quantities, order-independent); cart prices are copied only after a match.
Measurements are observed, never inferred; a missing/mismatched profile fails
closed.

## 5. Human approval before any customer price

- The model-facing `getShippingQuote` tool runs server-side and returns only
  non-price status (`quoted`, `reused`, `unavailable`, `handoff_required`).
  It exposes no amount, credit, carrier, service, quote id, expiry, address,
  product, or measurement.
- On a fresh or reused draft the server creates one redacted
  `shipping_approval` handoff. The ops digest carries only the draft-created
  pin, net customer charge, total credit, carrier, service, and ETA.
- Ops resolves with the exact structured commands `APPROVE_SHIPPING` or
  `REJECT_SHIPPING`. The decision is revalidated against the current,
  unexpired draft before it is persisted.
- The model cannot forge `shipping_approval`: `requestHumanAssistance`
  rejects that kind. No approval amount is relayed to the customer or model.
- An expired draft must be re-quoted, never reused.

## 6. 25 kg rule and the credit rule

- At or below 25,000 g the cart is a **single-package candidate** (readiness
  only). Exactly 25,000 g is still a candidate.
- Above 25,000 g a **balanced split is required**. The minimum package count
  is `ceil(total / 25_000)`; items are never auto-assigned to parcels
  (`manual_unresolved`). Do not implement an unverified packing heuristic.
- Missing/null weight or dimensions for any line produce `unavailable`, never
  a fabricated parcel.
- Credit: each unit priced strictly above 50,000 cents ($500) contributes
  12,000 cents ($120); credits sum; the customer pays
  `max(0, bestEligibleRateCents − totalCreditCents)`.

## 7. Offline / negative validation checks

These run without any network, provider, or database. They guard the
default-off contract and fail-closed behavior.

- **Default-off boot:** with `SHIPPING_QUOTES_ENABLED` unset, the shipping
  module graph is empty and the tool inventory is twelve.
- **Launch-preflight posture:** `pnpm preflight:launch` requires the flag to be
  exactly `false` (see §1) and lists the seven shipping activation
  preconditions from §10 as `manual_external` checks. Those manual checks are
  never counted as automatic failures, and no credential value is read or
  printed.
- **Flag/config:** `TRUE`, `False`, `1`, `yes`, and padded `' true '` do not
  enable; only `true` does. When enabled, missing/blank credentials or origin
  (or a non-5-digit postal code) fail boot fast.
- **Malformed profile:** enabled boot with an absent/malformed/oversized
  `SHIPPING_DEMO_PARCEL_PROFILE_JSON` does not fail and resolves to `null`.
- **Sale gate:** any non-null server-written `shippingQuoteDraft` or
  `shippingApproval` marker makes `createSale` return `shippingUnpersistable`
  before the idempotency key is minted or the backend is called. An
  address-only sale still passes.
- **Credit boundary:** 50,000 cents is exclusive; the customer payment is
  never negative; overflow fails explicitly.
- **Readiness:** missing measurements return `unavailable`; >25 kg returns
  `balanced_split_required` with `manual_unresolved`.
- **Approval grammar:** only exact `APPROVE_SHIPPING`/`REJECT_SHIPPING` parse;
  prose, prefixes, and reasons fail closed.
- **Secret safety:** validation errors and provider results never contain
  tokens, secrets, addresses, phones, or raw provider bodies.

## 8. Sandbox smoke PLAN (not performed)

**This has not been executed.** The owner must provision the sandbox host and
credentials first; do not run it against production. Record every step's
outcome in the evidence log (§9).

Prerequisites:

- Owner-confirmed sandbox endpoint and credentials, with that host separately
  approved; no fallback to the compiled production default.
- A private measured demo profile matching one synthetic cart exactly.
- The ops phone configured; the customer is a Meta test-number recipient.
- A local-only env (never committed) with the secrets from §2.

Plan:

1. Set `SHIPPING_QUOTES_ENABLED=true` plus the full origin and profile in a
   local/dev env only. Restart and confirm the tool inventory is thirteen.
2. Start one synthetic cart that matches the measured profile and has a
   stored delivery ZIP/state. Call `getShippingQuote` and confirm the model
   sees a non-price status only.
3. Confirm one redacted `shipping_approval` digest reaches ops with the net
   charge, credit, carrier, service, and pin, and no address/phone/product.
4. Reply `APPROVE_SHIPPING`; confirm the decision is validated against the
   current unexpired draft.
5. Attempt `createSale` for the shipping cart and confirm
   `shippingUnpersistable` (sale remains blocked).
6. Perform the §11 rollback (flag off + restart) and confirm the newly
   booted graph cannot initiate provider calls or approval requests; separately
   account for any requests already in flight before the restart.

## 9. Evidence capture (no PII)

Capture only: UTC timestamp, environment name, posture read as
present/absent (never the value), finite outcome labels
(`quoted`/`reused`/`unavailable`/`handoff_required`/`needs_decision`/
`ops_error`), HTTP status **class** only, ops request references of the form
`HF-<12 hex>`, and expiry as a relative time.

Never capture: customer phone/`wa_id`, full or partial address, product
names/ids, measurements or parcel values, customer-facing monetary amounts,
client id/secret/bearer tokens, full provider URLs, raw provider request or
response bodies, raw exception text, or any `.env` value.

## 10. Activation blockers (all open)

Live activation remains blocked until **all seven** are observed:

1. Branch origin postal/address data is authoritative.
2. Product and variant weights/dimensions are populated and exposed by the
   backend instead of `packageInfo: null`.
3. Skydropx sandbox/production credentials and the allowlisted provider host
   are owner-provisioned.
4. The backend can persist the approved shipping charge with the sale or a
   separately agreed domain path. The current backend `CreateSaleInput` has
   no shipping-charge field, so a shipping sale cannot be completed honestly.
5. CDMX free-zone rules and the service-selection policy are approved.
6. The human shipping-approval workflow is proven end to end.
7. A controlled synthetic shipping journey passes before any customer sees a
   quote.

## 11. Rollback — `SHIPPING_QUOTES_ENABLED=false` + restart

Set the flag to `false` and restart (graceful restart/redeploy; the flag is
evaluated at module build time, not live).

What it **does**:

- Rebuilds the module graph as empty: no token/quotation client, no provider,
  no orchestrator, and no `getShippingQuote` tool.
- Prevents the newly booted graph from starting provider calls, quote drafts,
  or shipping-approval requests. Gracefully drain old instances and account
  for in-flight requests: the flag does not cancel them.

What it **does not** do:

- It does not delete or rewrite persisted conversation state. Existing
  `shippingQuoteDraft` and `shippingApproval` keys in conversation JSONB stay
  in place, and the sale gate still blocks `createSale` for those
  conversations (the gate ignores the flag). An expired draft is not reused,
  but the marker keeps blocking until the normal clear/lifecycle path removes
  it.
- It does not recall or un-send messages already delivered to the customer
  or ops, does not delete pending `human_handoff_requests` rows, and does not
  undo a persisted approval/rejection decision.

Reverting the underlying code additionally means reverting the shipping
commits; that is a separate, explicitly authorized action.

## 12. Status

Shipping quotes remain default-off and **not live-ready**. Completing SQ-6A
authorizes no live provider call, no deployment, and no customer-facing
shipping price. All seven blockers in §10 must be satisfied separately before
any customer journey depends on a quote.
