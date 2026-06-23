# Program Context Seed: WhatsApp AI Chatbot

> **Last updated**: 2026-06-22
> **Source of truth repo**: `houndfe-backend` ([git@github.com:ALDRICHCODE45/houndfe-backend.git](https://github.com/ALDRICHCODE45/houndfe-backend))

---

## 1. How to Use This File

You are in repo **`houndfe-chatbot`**. This document is your bootstrap artifact — it contains the full program history, architecture, and API contracts you need to build the WhatsApp channel service.

**Key rules:**

- The **program history** lives in the Engram project `houndfe-backend`. To recover full context, run:
  ```
  mem_search(query: "<your topic>", project: "houndfe-backend")
  ```
- **Save NEW work** for this repo under its own Engram project (auto-detected from git remote).
- The backend at `git@github.com:ALDRICHCODE45/houndfe-backend.git` is the **transaction source of truth** and exposes the `chatbot-api` you consume. You do NOT modify backend code.
- The conversation-analysis living document (R1–R16 flows) lives in the backend repo at:
  ```
  openspec/changes/archive/2026-06-11-whatsapp-ai-chatbot/conversation-analysis.md
  ```
- When starting a new SDD cycle for this repo, search Engram with `project: 'houndfe-backend'` for prior decisions and archived slice reports before proposing.

---

## 2. Program Goal & Success Criteria

**Goal**: Build a 24/7 WhatsApp AI sales chatbot for HoundFe, a Mexican retail/POS business. The chatbot handles customer inquiries, product search, cart building, order placement, payment receipt collection, and delivery tracking — all via WhatsApp.

**Success criteria**:
- Customers can browse products, build a cart, and place orders entirely through WhatsApp
- Transfer payment receipts are collected by the bot and routed to human confirmation
- Shipping quotes are calculated (Skydropx) with credit rules applied
- Human handoff works for edge cases the bot cannot handle
- Monthly LLM cost stays under $200 USD hard ceiling
- WhatsApp messaging costs near-zero for service conversations (per Meta pricing: inbound + 24h-window replies are free)

---

## 3. Architecture & Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Meta Cloud API (WhatsApp)                       │
│                  webhook events ↓          ↑ send messages             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌──────────────────────────────┐    ┌────────────────────────────┐   │
│   │    houndfe-chatbot (VPS 2)   │    │  houndfe-backend (VPS 1)   │   │
│   │                              │    │       Dokploy-hosted        │   │
│   │  - WhatsApp webhook receiver │    │                            │   │
│   │  - Signature verification    │◄──►│  /chatbot-api/*            │   │
│   │  - LLM agent + tools         │HTTP│  (ServiceCredential auth)  │   │
│   │  - Conversation persistence  │    │                            │   │
│   │  - Skydropx client           │    │  PostgreSQL (Prisma ORM)   │   │
│   │  - Session/state management  │    │  Domain: Sales, Customers, │   │
│   │                              │    │  Products, Promotions,     │   │
│   └──────────────────────────────┘    │  Receipts, Audit           │   │
│                                        └────────────────────────────┘   │
│                                                                         │
│   ┌──────────────────────────────┐                                     │
│   │       Skydropx API           │                                     │
│   │  (shipping quotes + labels)  │                                     │
│   └──────────────────────────────┘                                     │
│                                                                         │
│   ┌──────────────────────────────┐                                     │
│   │       LLM Provider           │                                     │
│   │  ($200/mo budget cap)        │                                     │
│   └──────────────────────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key architectural decisions:**
- **Backend is the source of truth** for all transactional data (sales, customers, products, payments, receipts). The chatbot NEVER writes directly to the backend database.
- **Chatbot is a separate service** on a separate VPS. It communicates with the backend exclusively through the `chatbot-api` HTTP endpoints.
- **Payment v1**: Bot collects transfer receipt images → backend stores as `PENDING` → human confirms/rejects via backend's receipt-review workflow → payment recorded.
- **Shipping**: Skydropx integration (behind a port for future provider swap). Credit rule: $120 MXN credit per item >$500, credits sum, customer pays only excess over best quote.
- **System "tenants" are branches (sucursales)**, NOT SaaS multi-tenancy. HoundFe is a single business with multiple physical locations.

---

## 4. Backend Chatbot-API Contract

### 4.1 Authentication

| Aspect | Detail |
|--------|--------|
| **Header** | `Authorization: Bearer svc_<raw-api-key>` |
| **Key format** | Must start with `svc_` prefix |
| **Hash scheme** | SHA-256 of the raw key, stored as hex in `ServiceCredential.hashedKey` (unique index) |
| **Hash comparison** | `crypto.timingSafeEqual` on the Buffer-decoded hex hashes |
| **Branch context** | Optional `X-Branch-Id` header; if present, must match `credential.tenantId` or → `403 Forbidden` |
| **CLS context set** | `tenantId` = credential's tenant, `userId` = `service:<credentialId>`, `isSuperAdmin` = false |
| **Scope enforcement** | `@RequiredScopes(...)` decorator; method-level scopes **replace** (not merge) class-level scopes via `getAllAndOverride` |
| **Rate limiting** | In-memory sliding window per credential; `credential.rateLimit` requests per 60s window (default: 60). Returns `429 Too Many Requests` with `Retry-After` header (seconds) |
| **Credential lifecycle** | `isActive` must be true AND `revokedAt` must be null; `lastUsedAt` is touched on every successful auth |
| **Audit** | `BotAuditInterceptor` logs every request (success + error) to `BotAuditLog` with action, resource type/id, HTTP method, status code, outcome |

**Error responses:**
- `401 Unauthorized` — missing/invalid Bearer token, inactive credential, revoked credential
- `403 Forbidden` — insufficient scopes, branch mismatch
- `429 Too Many Requests` — rate limit exceeded (includes `Retry-After` header)

### 4.2 ServiceCredential Model

```
ServiceCredential {
  id:         string (UUID)
  tenantId:   string (UUID, FK → Tenant)
  name:       string
  hashedKey:  string (SHA-256 hex, unique)
  scopes:     string[] (e.g. ["catalog:read", "sales:create"])
  isActive:   boolean (default true)
  lastUsedAt: DateTime | null
  rateLimit:  number (default 60, requests per 60s)
  createdAt:  DateTime
  revokedAt:  DateTime | null
}
```

**Known scopes** (from code):
- `catalog:read` — catalog search, stock check (class-level default)
- `pricing:evaluate` — cart pricing evaluation
- `customers:read` — customer lookup, order history
- `customers:write` — customer upsert
- `sales:create` — bot sale registration
- `sales:write` — receipt attachment, delivery metadata

### 4.3 Idempotency

Bot sale registration uses a dedicated `SaleIdempotency` table:
- **Header**: `X-Idempotency-Key` (sent with `POST /chatbot-api/sales`)
- **Scope**: Per-tenant, operation `bot_sale_register`, keyed by the idempotency key value
- **Behavior**: If key already exists with `status: SUCCEEDED`, returns cached `responseJson` without re-creating the sale
- **Flow**: Reserve slot as `IN_FLIGHT` → create sale → mark `SUCCEEDED` with response
- **Ambiguity**: Namespace is shared across credentials within the same tenant (acceptable for single-bot-per-branch v1; see W-003 in archive)

### 4.4 Endpoint Reference

All routes are prefixed with `/chatbot-api/`. All require `ServiceAuthGuard` (Bearer + scopes). All are audit-logged.

---

#### 4.4.1 GET `/chatbot-api/catalog/search`

**Scopes**: `catalog:read`

**Query parameters:**
| Param | Type | Validation | Default |
|-------|------|-----------|---------|
| `q` | string | `@IsString()`, required | — |
| `limit` | number | `@IsOptional()`, `@IsInt()`, `@Min(1)`, `@Max(20)` | `10` |

**Response** `200`: `CatalogItemResponse[]`
```typescript
interface CatalogItemResponse {
  productId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  description: string | null;
  price: {
    priceCents: number | null;
    fromPriceCents: number | null;       // min variant price if has variants
    promoPriceCents: number | null;      // always null in search (use evaluate-cart)
    promotionEvaluationStatus: "needs_human_review";  // hardcoded in search
  };
  stock: {
    status: "available" | "low_stock" | "out_of_stock" | "not_managed";
    quantity: number | null;
  };
  packageInfo: {
    weightGrams: null;       // not yet implemented
    dimensions: null;        // not yet implemented
  };
  variants: Array<{
    variantId: string;
    name: string;
    option: string | null;
    value: string | null;
    priceCents: number | null;
    stock: {
      status: "available" | "low_stock" | "out_of_stock" | "not_managed";
      quantity: number | null;
    };
  }>;
}
```

**Notes**: Bot-safe projection — no cost, margin, or supplier data is exposed.

---

#### 4.4.2 GET `/chatbot-api/catalog/:productId/stock`

**Scopes**: `catalog:read`

**Path parameters:**
| Param | Type | Validation |
|-------|------|-----------|
| `productId` | string | `ParseUUIDPipe` |

**Response** `200`: `StockCheckResponse`
```typescript
interface StockCheckResponse {
  productId: string;
  name: string;
  stock: {
    status: "available" | "low_stock" | "out_of_stock" | "not_managed";
    quantity: number | null;
  };
  variants: Array<{
    variantId: string;
    name: string;
    option: string | null;
    value: string | null;
    stock: {
      status: "available" | "low_stock" | "out_of_stock" | "not_managed";
      quantity: number | null;
    };
  }>;
}
```

**Error**: `404 Not Found` if product does not exist.

---

#### 4.4.3 POST `/chatbot-api/pricing/evaluate-cart`

**Scopes**: `pricing:evaluate`

**Request body:**
```typescript
{
  items: Array<{                        // @ArrayMinSize(1)
    productId: string;                  // @IsUUID()
    variantId?: string;                 // @IsOptional(), @IsUUID()
    quantity: number;                   // @IsInt(), @Min(1)
    unitPriceCents: number;             // @IsInt(), @Min(0)
  }>;
}
```

**Response** `201`: `CartEvaluationResult`
```typescript
interface CartEvaluationResult {
  items: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
    unitPriceCents: number;
    originalPriceCents: number;
    finalPriceCents: number;
    appliedPromotionTitle: string | null;
    discountAmountCents: number;
  }>;
  promotionEvaluationStatus: "fully_evaluated" | "needs_human_review";
}
```

**Notes**: Only `PRODUCT_DISCOUNT` promotion type is auto-evaluated; complex types return `needs_human_review`.

---

#### 4.4.4 GET `/chatbot-api/customers/by-phone`

**Scopes**: `customers:read`

**Query parameters:**
| Param | Type | Validation |
|-------|------|-----------|
| `phoneCountryCode` | string | `@IsString()`, `@MaxLength(10)`, required |
| `phone` | string | `@IsString()`, `@MaxLength(20)`, required |

**Response** `200`: `CustomerLookupResponse`
```typescript
interface CustomerLookupResponse {
  found: boolean;
  customer: CustomerProfileResponse | null;
}

interface CustomerProfileResponse {
  customerId: string;
  firstName: string;
  lastName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  preferredPaymentMethod: string | null;
  address: CustomerDeliveryAddressResponse | null;
}

interface CustomerDeliveryAddressResponse {
  id: string;
  label: string | null;
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  visualReferences: string | null;
  carrierPhone: string | null;
}
```

**Notes**: Phone digits are normalized (non-digit chars stripped). Returns `found: false` with `customer: null` if no match.

---

#### 4.4.5 PUT `/chatbot-api/customers/by-phone`

**Scopes**: `customers:write`

**Request body:**
```typescript
{
  firstName: string;                   // @IsString(), @MaxLength(100), required
  lastName?: string;                   // @IsOptional(), @MaxLength(100)
  phoneCountryCode: string;            // @IsString(), @MaxLength(10), required
  phone: string;                       // @IsString(), @MaxLength(20), required
  preferredPaymentMethod?: string;     // @IsOptional(), @MaxLength(50)
  address: {                           // required, @ValidateNested()
    label?: string;                    // @IsOptional(), @MaxLength(100)
    street: string;                    // @IsString(), @MaxLength(200), required
    exteriorNumber?: string;           // @IsOptional(), @MaxLength(20)
    interiorNumber?: string;           // @IsOptional(), @MaxLength(20)
    zipCode?: string;                  // @IsOptional(), @MaxLength(10)
    neighborhood?: string;             // @IsOptional(), @MaxLength(100)
    municipality?: string;             // @IsOptional(), @MaxLength(100)
    city?: string;                     // @IsOptional(), @MaxLength(100)
    state?: string;                    // @IsOptional(), @IsIn(MEXICAN_STATES)
    visualReferences?: string;         // @IsOptional(), @MaxLength(500)
    carrierPhone?: string;             // @IsOptional(), @MaxLength(20)
  };
}
```

**Response** `200`: `CustomerUpsertResponse`
```typescript
interface CustomerUpsertResponse {
  status: "created" | "updated";
  customer: CustomerProfileResponse;    // same shape as lookup response
}
```

**Notes**: Upserts by phone match. Creates customer + address if new; updates both if existing. Address is upserted (oldest address updated, or new one created).

---

#### 4.4.6 POST `/chatbot-api/sales`

**Scopes**: `sales:create`

**Required header**: `X-Idempotency-Key: <string>` (see Section 4.3)

**Request body:**
```typescript
{
  cashierUserId: string;               // @IsUUID(), required — must be a valid User.id
  customerId: string;                  // @IsUUID(), required
  shippingAddressId?: string | null;   // @IsOptional(), @IsUUID()
  items: Array<{                       // @ArrayMinSize(1)
    productId: string;                 // @IsUUID()
    variantId?: string | null;         // @IsOptional(), @IsUUID()
    productName: string;               // @IsString(), @IsNotEmpty()
    variantName?: string | null;       // @IsOptional()
    quantity: number;                  // @IsInt(), @Min(1)
    unitPriceCents: number;            // @IsInt(), @Min(0)
  }>;
}
```

**Response** `201`: `BotSaleResponse`
```typescript
interface BotSaleResponse {
  saleId: string;
  folio: string | null;
  paymentStatus: "CREDIT" | "PARTIAL" | "PAID";
  channel: string;                     // always "ONLINE" for bot sales
  deliveryStatus: string;              // initial: "PENDING"
  totalCents: number;
  paidCents: number;
  debtCents: number;
  confirmedAt: string | null;          // ISO 8601
}
```

**Notes**:
- Creates a CONFIRMED ONLINE sale with `paymentStatus: CREDIT` (pending transfer payment).
- `cashierUserId` must be a seeded bot-dedicated User record (FK constraint on `Sale.userId`). The bot's identity is attributed via `BotAuditLog`, not the sale's userId.
- Routes through `SalesService.confirmBotSale()` which enforces all domain invariants: folio allocation, stock decrement, price validation, dueDate, domain event emission (`sale.confirmed` outbox event).
- Idempotent: same `X-Idempotency-Key` returns the cached response.

---

#### 4.4.7 POST `/chatbot-api/sales/:saleId/receipts`

**Scopes**: `sales:write`

**Path parameters:**
| Param | Type | Validation |
|-------|------|-----------|
| `saleId` | string | `ParseUUIDPipe` |

**Request body:**
```typescript
{
  mediaUrl: string;                    // @IsUrl(), required
  declaredAmountCents: number;         // @IsInt(), @Min(1), required
  declaredDate?: string | null;        // @IsOptional(), @IsISO8601()
  declaredReference?: string | null;   // @IsOptional(), @IsString(), @IsNotEmpty()
}
```

**Response** `201`: `AttachReceiptResponse`
```typescript
interface AttachReceiptResponse {
  receiptId: string;
  status: "PENDING";                   // always PENDING; human confirms later
}
```

**Notes**: The receipt stays `PENDING` until a human uses the backend's receipt-review workflow (separate from chatbot-api) to confirm or reject it. Confirmation triggers a `TRANSFER` payment on the sale.

---

#### 4.4.8 PATCH `/chatbot-api/sales/:saleId/delivery`

**Scopes**: `sales:write`

**Path parameters:**
| Param | Type | Validation |
|-------|------|-----------|
| `saleId` | string | `ParseUUIDPipe` |

**Request body:**
```typescript
{
  carrierName?: string | null;         // @IsOptional(), @IsString(), @IsNotEmpty()
  trackingRef?: string | null;         // @IsOptional(), @IsString(), @IsNotEmpty()
  estimatedDeliveryAt?: string | null; // @IsOptional(), @IsISO8601()
}
```

**Response** `200`: `{}` (empty object)

**Preconditions** (enforced in service; throws `BusinessRuleViolationError` if violated):
- Sale must exist
- `sale.status === 'CONFIRMED'`
- `sale.paymentStatus === 'PAID'`
- `sale.channel === 'ONLINE'`
- `sale.deliveryStatus !== 'DELIVERED'`

**Side effect**: Sets `deliveryStatus` to `SHIPPED`.

---

#### 4.4.9 GET `/chatbot-api/customers/by-phone/:phone/orders`

**Scopes**: `customers:read`

**Path parameters:**
| Param | Type |
|-------|------|
| `phone` | string (raw path segment, not UUID) |

**Query parameters:**
| Param | Type | Notes |
|-------|------|-------|
| `phoneCountryCode` | string | Required (no validation decorator — **ambiguity**: controller extracts via `@Query('phoneCountryCode')` with no DTO, defaults to `''` if missing) |

**Response** `200`: `OrderHistoryResponse[]`
```typescript
interface OrderHistoryResponse {
  saleId: string;
  folio: string | null;
  confirmedAt: string | null;          // ISO 8601
  channel: string;
  deliveryStatus: string;
  paymentStatus: string | null;
  totalCents: number;
  paidCents: number;
  debtCents: number;
  items: Array<{
    productId: string;
    variantId: string | null;
    productName: string;
    variantName: string | null;
    quantity: number;
    unitPriceCents: number;
  }>;
  payments: Array<{
    method: string;
    amountCents: number;
    reference: string | null;
  }>;
  shippingAddress: {
    street: string | null;
    zipCode: string | null;
  } | null;
}
```

**Notes**: Returns up to 5 most recent CONFIRMED sales for the customer. Returns `[]` if no customer found. Used for "same as last time" reorder flows.

---

### 4.5 Endpoint Summary Table

| # | Method | Path | Scopes | Idempotent | Status |
|---|--------|------|--------|-----------|--------|
| 1 | GET | `/chatbot-api/catalog/search` | `catalog:read` | N/A (read) | 200 |
| 2 | GET | `/chatbot-api/catalog/:productId/stock` | `catalog:read` | N/A (read) | 200 / 404 |
| 3 | POST | `/chatbot-api/pricing/evaluate-cart` | `pricing:evaluate` | No | 201 |
| 4 | GET | `/chatbot-api/customers/by-phone` | `customers:read` | N/A (read) | 200 |
| 5 | PUT | `/chatbot-api/customers/by-phone` | `customers:write` | No (upsert) | 200 |
| 6 | POST | `/chatbot-api/sales` | `sales:create` | Yes (`X-Idempotency-Key`) | 201 |
| 7 | POST | `/chatbot-api/sales/:saleId/receipts` | `sales:write` | No | 201 |
| 8 | PATCH | `/chatbot-api/sales/:saleId/delivery` | `sales:write` | No | 200 |
| 9 | GET | `/chatbot-api/customers/by-phone/:phone/orders` | `customers:read` | N/A (read) | 200 |

**Total: 9 endpoints** (4 GET, 3 POST, 1 PUT, 1 PATCH)

---

## 5. Data/Schema Contracts

### 5.1 Models the Chatbot Relies On

| Model | Role for Chatbot |
|-------|-----------------|
| `ServiceCredential` | API-key auth; scopes, rate limit, tenant binding |
| `BotAuditLog` | Audit trail for all chatbot-api calls |
| `SaleIdempotency` | Prevents duplicate bot sale creation |
| `Sale` | Bot-created sales (channel=ONLINE, status=CONFIRMED) |
| `SaleItem` | Line items on bot sales |
| `SalePayment` | Payments (created by receipt-review, not by bot directly) |
| `ReceiptEvidence` | Transfer receipt images (bot creates as PENDING) |
| `Customer` | Customer profiles (phone-indexed for WhatsApp lookup) |
| `CustomerAddress` | Delivery addresses |
| `OutboxEvent` | Domain events emitted on `sale.confirmed` |

### 5.2 Key Enums

```
SaleStatus:          DRAFT | CONFIRMED
SaleChannel:         POS | ONLINE
SaleDeliveryStatus:  PENDING | DELIVERED | NOT_APPLICABLE | SHIPPED
SalePaymentStatus:   PAID | PARTIAL | CREDIT
SalePaymentMethod:   CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER | CREDIT
ReceiptEvidenceStatus: PENDING | CONFIRMED | REJECTED
SaleIdempotencyStatus: IN_FLIGHT | SUCCEEDED | FAILED
```

### 5.3 Prerequisites Before Go-Live

- **Seed a dedicated bot cashier user**: `Sale.userId` has a FK constraint to `User.id`. The bot must use a real User record as `cashierUserId`. Create a dedicated user for this purpose.
- **Provision a ServiceCredential**: Create a credential record with the appropriate scopes, linked to the target branch's `tenantId`. The raw API key (prefixed `svc_`) is given to the chatbot; only the SHA-256 hash is stored.

---

## 6. What is DONE (3 Archived Slices)

### Slice 1: `chatbot-api-foundation` (archived 2026-06-11)

**Delivered**: Complete internal API for the chatbot service (9 endpoints, auth, audit, rate limiting, idempotency). All 49 implementation tasks complete. 56 chatbot-api tests, 1136 full suite with zero regressions. 4 additive Prisma migrations.

**Verdict**: PASS_WITH_WARNINGS (0 critical, 5 warnings, 4 suggestions).

**Engram topic**: `sdd/whatsapp-ai-chatbot/archive-report` (#2308)

### Slice 2: `receipt-payment-confirmation` (archived 2026-06-13)

**Delivered**: Human-facing receipt review workflow closing W-005. Permission-gated confirm/reject flow. Receipt confirmation triggers a `TRANSFER` payment on the sale via unified domain path. Emits `receipt.confirmed` / `receipt.rejected` events. Added `Customer.isTrusted` flag.

**Verdict**: PASS_WITH_WARNINGS (38/38 tasks, 16/16 spec scenarios).

**Engram topic**: `sdd/receipt-payment-confirmation/archive-report` (#2351)

### Slice 3: `bot-sale-domain-events` (archived 2026-06-15)

**Delivered**: Fixed W-004 (registerBotSale bypassed SalesService domain layer) and S-004 (no domain events emitted for bot sales). Created `SalesService.confirmBotSale()` with all 6 invariants (folio, stock, price validation, dueDate, seller, domain event). 149 targeted tests pass.

**Verdict**: PASS_WITH_WARNINGS (0 critical).

**Engram topic**: Session summary (#2373)

---

## 7. What is NEXT

### `whatsapp-channel-foundation` — Next Slice

**Scope**: Stand up the `houndfe-chatbot` repo on its own VPS and wire the WhatsApp webhook channel to consume the backend chatbot-api.

**Deliverables**:
1. New repo scaffolding (`houndfe-chatbot`)
2. Meta WhatsApp webhook receiver (signature verification with `X-Hub-Signature-256`)
3. Send/receive messages against the Meta Cloud API test number
4. HTTP client for `chatbot-api` (API key auth, retry, error handling)
5. End-to-end echo bot (receive WhatsApp message → echo back)
6. Conversation/session persistence (initial structure)
7. Basic deployment to VPS 2

**Prerequisites / Blockers**:

| Prerequisite | Status | Notes |
|-------------|--------|-------|
| Meta WhatsApp test number | **BLOCKED** | Owner started verification paperwork (SAT Constancia + address proof). Test numbers work without business verification, but need owner to complete phone number registration on Meta dashboard. Verification takes 2–14 days. **Confirm current status with owner before starting.** |
| Dedicated bot cashier User record | NOT SEEDED | Must create in production DB before live sales |
| ServiceCredential provisioned | NOT PROVISIONED | Create with scopes: `catalog:read`, `pricing:evaluate`, `customers:read`, `customers:write`, `sales:create`, `sales:write` |
| VPS 2 provisioned | UNKNOWN | Separate VPS for chatbot service |
| LLM provider account | UNKNOWN | $200/mo cap; not needed for echo-bot slice but needed soon after |
| Skydropx sandbox account | UNKNOWN | Needed for shipping slice, not this one |

---

## 8. Future Slices Backlog

In priority order (from conversation-analysis R1–R16):

1. **LLM agent + conversation persistence** — AI agent with tools, conversation memory, session management
2. **Sale flow + cart/order** — Conversational cart building, product selection, order placement using chatbot-api endpoints
3. **Skydropx shipping** — Shipping quote calculation, credit rule ($120 MXN per item >$500), label generation
4. **Human handoff** — Escalation to human agent for edge cases (R6/R7), re-stock checks, complex promotions
5. **Image recognition** — Customer sends product photos, bot identifies products (R1)
6. **Delivery zones** — 4-state postal-code zones: FREE, SURCHARGE, CARRIER_ONLY, UNKNOWN (discovered during receipt-payment-confirmation)

**Remaining backend hardening** (minor, in houndfe-backend repo):
- W-001: Delivery metadata precondition guard clarification
- W-002: `timingSafeEqual` defense-in-depth (already implemented as of bot-sale-domain-events)
- W-003: Multi-bot credential namespace documentation
- S-002: Remove `any` type in `toOrderHistoryResponse`
- S-003: Document `getAllAndOverride` scope replacement behavior

---

## 9. Stack & Conventions

### Backend (`houndfe-backend`)

| Aspect | Detail |
|--------|--------|
| Runtime | Node.js + TypeScript 5.7 |
| Framework | NestJS 11 |
| ORM | Prisma 6.19 (PostgreSQL) |
| Auth (human) | Passport + JWT + CASL |
| Auth (service) | Custom `ServiceAuthGuard` (API key → SHA-256) |
| Multi-tenancy | `nestjs-cls` (CLS-based tenant context) |
| Package manager | **pnpm** |
| Test runner | **Jest 30** + ts-jest |
| Build | `pnpm build` (NestJS CLI → tsc) |
| Lint | `pnpm lint` — **CAUTION**: repo-wide lint is broken (pre-existing). Use `pnpm exec eslint src/chatbot-api` for scoped linting |
| Architecture | Screaming/feature-module: `src/<module>/{domain,application,infrastructure,presentation}` |
| Commits | Conventional commits (no AI co-author attribution) |
| Domain events | `@nestjs/event-emitter` + OutboxEvent table for durable delivery |

### Chatbot (`houndfe-chatbot`) — To Be Decided

Stack for the new repo is not yet locked. Consider:
- Runtime: Node.js (consistent with backend team knowledge)
- Framework: Lightweight (Fastify, Hono, or plain Express) — no need for NestJS complexity
- LLM: Provider TBD ($200/mo cap)
- Persistence: PostgreSQL or SQLite for conversation history
- Deployment: Separate VPS (not Dokploy)

---

## 10. Key Engram Topic Keys & References

### Engram Queries (project: `houndfe-backend`)

| Topic Key / Query | What You Get |
|-------------------|-------------|
| `sdd/whatsapp-ai-chatbot/archive-report` | Full archive report for chatbot-api-foundation (#2308) |
| `sdd/receipt-payment-confirmation/archive-report` | Receipt-review workflow archive (#2351) |
| Session summary #2373 | bot-sale-domain-events session (confirmBotSale, domain invariants) |
| Session summary #2309 | Original chatbot-api-foundation session (full program context) |
| `receipt-payment-confirmation audit attribution` | D7 decision on audit attribution (#2312) |
| `delivery zones payment precondition` | HoundFe delivery + payment rules (#2330) |

### File References (in `houndfe-backend` repo)

| File | Content |
|------|---------|
| `openspec/changes/archive/2026-06-11-whatsapp-ai-chatbot/conversation-analysis.md` | **LIVING DOCUMENT**: R1–R16 requirement-to-flow mappings, conversation state machine sketches, LLM prompt notes, known ambiguities |
| `openspec/changes/archive/2026-06-11-whatsapp-ai-chatbot/proposal.md` | Program scope, intent, success criteria |
| `openspec/changes/archive/2026-06-11-whatsapp-ai-chatbot/design.md` | Technical architecture decisions, data flow |
| `openspec/specs/chatbot-api-foundation/spec.md` | Canonical API spec |
| `openspec/specs/receipt-review/spec.md` | Receipt review workflow spec |
| `openspec/specs/sales/spec.md` | Sales capability (formalized with bot-sale-domain-events) |
| `openspec/specs/sale-payments/spec.md` | Sale payments spec |
| `docs/whatsapp-business-api-registro-meta.md` | Meta registration guide for the owner (Spanish) |

---

## 11. Open Questions / Risks for the New Repo

| # | Question / Risk | Impact | Notes |
|---|----------------|--------|-------|
| 1 | **Meta WhatsApp number verification status** | BLOCKING | Owner started paperwork. Test numbers work without verification, but confirm where the process stands. |
| 2 | **VPS 2 provisioning** | BLOCKING for deployment | Need server details, OS, domain/subdomain for webhook URL |
| 3 | **Webhook URL requirements** | Medium | Meta requires HTTPS webhook endpoint. Need SSL cert (Let's Encrypt) and public domain/subdomain |
| 4 | **Bot cashier User seeding** | BLOCKING for live sales | Must exist before `POST /chatbot-api/sales` can succeed (FK constraint) |
| 5 | **ServiceCredential provisioning** | BLOCKING for API access | No admin endpoint exists to create credentials — must be seeded directly in DB or via a seed script |
| 6 | **`phoneCountryCode` on order history endpoint** | Minor ambiguity | The `GET /chatbot-api/customers/by-phone/:phone/orders` endpoint takes `phoneCountryCode` as a raw `@Query()` param with no DTO validation — it defaults to `''` if missing. The chatbot should always send it. |
| 7 | **Rate limit adequacy** | Low | Default 60 req/min per credential. Adequate for v1 single-bot, but monitor. In-memory limiter resets on backend restart. |
| 8 | **LLM provider selection** | Medium | $200/mo hard cap. Need to select provider and model. Affects agent architecture. |
| 9 | **Conversation persistence strategy** | Medium | No design locked yet. Affects state management, context window, and handoff. |
| 10 | **`promotionEvaluationStatus: needs_human_review`** | Design choice | Catalog search always returns `needs_human_review` for promo pricing. The bot should use `evaluate-cart` for accurate pricing and still handle `needs_human_review` gracefully. |
| 11 | **WhatsApp message cost** | Low risk | Service conversations (user-initiated) are free within 24h window. Marketing templates ~$0.04 USD/msg MX. Keep bot reactive, not proactive, to control costs. |
| 12 | **Receipt image hosting** | Design decision | `attachReceipt` expects a `mediaUrl`. The chatbot needs to either: (a) host the WhatsApp-received image and provide a URL, or (b) use the Meta media download URL directly. Consider URL expiration. |

---

## 12. Session Log — Latest Decisions (2026-06-22)

> Appended after the seed was first generated. These decisions are program-critical and supersede any earlier assumptions.

### 12.1 Meta App & Test Number

- The Meta Developer Console **app is already created** by the owner.
- **Plan**: Use the **free Meta test number** (Dashboard → WhatsApp → API Setup) to build and validate the bot NOW, in development mode (sends to up to 5 verified recipients, temporary 24h token). This unblocks development without waiting for business verification.
- **Business verification** runs in parallel via Business Manager → Security Center → Start Verification. Mexico document checklist was prepared and a client-facing message (Spanish) requesting documents was drafted/sent.

### 12.2 Existing Number — Migration Decision (IMPORTANT, corrects earlier assumption)

Earlier it was assumed a brand-new number from scratch was MANDATORY. **That is not accurate.** The facts and the resulting decision:

- **A number lives in only ONE WhatsApp surface at a time**: the WhatsApp Business App OR the Cloud API — not both. Migrating the client's existing number to the Cloud API **removes it from the WhatsApp Business App** (all traffic then flows through the bot/API).
- **Conversations (chat history) do NOT migrate to the Cloud API.** The API only sees messages from registration onward. History can only be exported per-chat (manual, not bulk) and/or backed up (Google Drive/iCloud) as a read-only record — it cannot be imported into the bot.
- **Contacts ARE preservable**: they live in the device address book, not in WhatsApp. Export to CSV/vCard (Google Contacts / iCloud) and load later (maps to the `Customer` model).

**DECISION — phased approach:**
1. Build/validate the entire bot on the **test number**; do NOT touch the client's live number yet.
2. Defer the real-number choice (migrate existing number vs. use a new dedicated number) until the bot **and** human-handoff are production-ready, then do a planned cutover with a full backup beforehand.
3. Meanwhile, the client should **export contacts** (CSV/vCard) and **back up conversations** now, so they are covered for either path.

The client was informed in simple terms: **contacts are guaranteed, conversations are backed up (not inside the bot), and the number is decided without rush once the bot works.**

### 12.3 Backend State Reminder

- `houndfe-backend` `main` is **8 commits ahead of origin** (tech-debt cleanup W-001/W-002/S-001/S-002/S-003 merged locally). The owner must `git push origin main` when SSH/gh credentials are available in the environment. Engram observation: `bug/cleaned-chatbot-api-tech-debt-...` (#2385).

### 12.4 Separate Workstream (NOT part of this chatbot repo)

- A parallel effort is remodeling the POS **product creation form** (in `houndfe-backend` + `frontend-houndfe`). A full form spec was produced at `frontend-houndfe/docs/product-creation-form-spec.md` (Engram topic `products/create-form-spec`). This is unrelated to the chatbot program and does not affect `houndfe-chatbot`.
