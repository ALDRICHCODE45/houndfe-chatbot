# Customer pets — bot contract v1 (copy from the backend)

Copy of `houndfe-backend/docs/chatbot-handoff/customer-pets-bot-contract.md` (backend local main 1e22fb90, implemented and verified; received through intercom on 2026-11-23). The backend file is the source of truth; this copy is what chatbot workers read. Design history: backend `docs/proposals/customer-pets-contract.md`. Feature tracker: `odd/tasks/multi-pet-profiles.md`.

Shapes below come from the backend code. Where the code differs from the proposal, this document follows the code (see «Differences from the proposal» at the end).

## 0. Owner decisions this implements

| # | Decision | Where |
| --- | --- | --- |
| D1 | Pets live in the backend (Customer → pets), visible and editable from the POS | §1, §2 |
| D2 | With 2+ pets and no clear recipient the bot asks with buttons (bot-side behavior; the backend gives species, breed and age) | §2 |
| D3 | History per pet («¿lo mismo de siempre para Max?») | §6 |
| D4 | Allergies and notes: warning only; the backend stores the text and does not match it against products | §1 |
| D5 | Age that advances by itself (approximate birth date, never frozen text) | §3 |
| D6 / D9 | «Bruno ya no está» / «olvida a Bruno» → **archive** (restorable); explicit «olvida mis datos» → **real deletion** | §4.5, §4.6 |
| D7 | Printed ticket: no pet in v1 (POS only) | — |
| D8 | Several active pets with the same name are allowed; the backend warns with `warnings: ["PET_NAME_DUPLICATE"]` | §1, §3 |
| D10 | At most **20 ACTIVE** pets per customer | §1 |

## 1. Scopes, model and limits

Credential: `Authorization: Bearer svc_…`. **New scopes** (add them to the chatbot credential before deploy): `pets:read`, `pets:write`, `pets:delete`. A route without its scope answers `403`; `X-Branch-Id`, when sent, must be the credential's sucursal.

| Scope | Routes |
| --- | --- |
| `pets:read` | `GET /chatbot-api/customers/:customerId/pets`; also makes `customer.pets` appear in `GET /chatbot-api/customers/by-phone` |
| `pets:write` | `POST` (create), `PATCH`, `POST …/archive`, `POST …/restore` |
| `pets:delete` | `DELETE …/:petId?version=N` (real erasure) |

`GET customers/by-phone` still needs **`customers:read`**; to receive `customer.pets` the credential needs **`customers:read` and `pets:read`**. Without `pets:read` the `pets` key is **absent** (not an empty array) and the response is exactly the previous one. The order-history route (`customers:read`) needs no pet scope: the per-line `pet` and `?petId=` work with `customers:read` alone.

Budgets: the `GET` pet route is in the `read` bucket; create, PATCH, archive, restore and DELETE are in the `write` bucket (the credential's per-class limits, `429` + `Retry-After`).

A pet belongs to one customer of the credential's sucursal.

| Field | Rule |
| --- | --- |
| `name` | required, trimmed, 1–60 characters |
| `species` | required: `DOG`, `CAT` or `OTHER` |
| `speciesOther` | ≤ 40, **required when `species` is `OTHER`**, must be empty otherwise |
| `breed` | ≤ 80, optional |
| `size` | optional: `SMALL`, `MEDIUM`, `LARGE`, `GIANT` |
| `birthDate` + `birthDatePrecision` | optional pair, see §3 |
| `allergies`, `notes` | ≤ 500 each, optional (warning only) |
| `status` | `ACTIVE` or `ARCHIVED` |
| `createdVia` | `CHATBOT` for pets you create, `POS` for staff |
| `version` | starts at 1; +1 on every write (edit, archive, restore) |

Text fields are trimmed; a blank string is stored as `null`.

- **At most 20 ACTIVE pets per customer.** Create or restore past it → `422 PET_LIMIT_REACHED`. Archived pets do not count.
- **Duplicate names are allowed** among active pets. Create, PATCH (when the name changes) and restore answer `warnings: ["PET_NAME_DUPLICATE"]` when another ACTIVE pet of the same customer has the same name (case and accents ignored, spaces collapsed); the write still succeeds. Disambiguate with species, breed and age, and always work with `id`.
- `GET …?status=ARCHIVED|ALL` is capped at **100** rows; `ACTIVE` is not capped (it cannot exceed 20).

Errors have the code-only body `{ "statusCode", "error", "message" }` with `error === message`, plus the detail member listed in §9. Validation failures (`400`) use the standard per-field body (`message` is an array of `{ property, children, constraints }`, `error: "Bad Request"`). Unknown failures answer `500 CUSTOMER_PET_REQUEST_FAILED`.

## 2. Pet shape (shared by every route)

```json
{
  "id": "8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11",
  "customerId": "5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90",
  "name": "Bruno",
  "species": "DOG",
  "speciesOther": null,
  "breed": "Chihuahua",
  "size": "SMALL",
  "birthDate": "2026-01-01",
  "birthDatePrecision": "MONTH",
  "ageMonths": 10,
  "ageLabel": "~10 meses",
  "allergies": "Pollo",
  "notes": null,
  "status": "ACTIVE",
  "archivedAt": null,
  "archivedReason": null,
  "createdVia": "CHATBOT",
  "version": 3,
  "createdAt": "2026-11-23T16:20:11.000Z",
  "updatedAt": "2026-11-23T16:20:11.000Z"
}
```

Every **write** (create, PATCH, archive, restore) returns the **complete pet** plus `"warnings": string[]` (empty when none). `GET` returns an array of pets (no `warnings`).

`GET /chatbot-api/customers/:customerId/pets?status=ACTIVE|ARCHIVED|ALL` (scope `pets:read`) → `200 [Pet, …]`. Default `ACTIVE`, sorted by name (accents and case ignored; ties by creation, then id). `ARCHIVED` sorted by `archivedAt` descending, `ALL` newest first. Unknown customer → `404 CUSTOMER_NOT_FOUND`; another `status` → `400`.

`customer.pets` in `GET /chatbot-api/customers/by-phone?phoneCountryCode=52&phone=5512349901` is the same array, **ACTIVE pets only**, same order:

```json
{ "found": true,
  "customer": { "customerId": "5c1e9a02-…", "firstName": "Ana", "lastName": null,
                "phoneCountryCode": "52", "phone": "5512349901",
                "preferredPaymentMethod": null, "address": null,
                "pets": [ { "id": "8d0e0f6e-…", "name": "Bruno", "ageLabel": "~10 meses", "…": "…" } ] } }
```

Read archived pets through `GET …/pets?status=ARCHIVED|ALL`. No feed event is written when staff edit a pet: read the pets on each turn.

## 3. Age

Never stored; `ageMonths` and `ageLabel` are computed at read time from `birthDate` in the business timezone (default `America/Mexico_City`). Both are non-null **whenever `birthDate` is set, in every response that carries a pet, write responses included**, and `null` otherwise.

| `birthDatePrecision` | Label examples | Meaning |
| --- | --- | --- |
| `EXACT` | `«10 meses»`, `«3 años»`, `«1 año 4 meses»` | real birth date |
| `MONTH` or `YEAR` | `«~10 meses»`, `«~3 años»` | approximate; prefix `«~»` (never «aprox») |
| any | `«menos de 1 mes»` | under one month (no prefix) |

Send **either** an exact date **or** an approximate age:

| You send | Stored |
| --- | --- |
| `"birthDate": "2024-03-15", "birthDatePrecision": "EXACT"` | as sent |
| `"birthDate": "2024-03-20", "birthDatePrecision": "MONTH"` | `2024-03-01` |
| `"birthDate": "2024-03-20", "birthDatePrecision": "YEAR"` | `2024-01-01` |
| `"approxAge": { "months": 10 }` | first day of (today − 10 months), `MONTH` |
| `"approxAge": { "years": 3 }` | January 1 of (current year − 3), `YEAR` |
| `"approxAge": { "years": 1, "months": 4 }` | first day of (today − 16 months), `MONTH` |

- `approxAge`: whole numbers, `years` 0–50 and/or `months` 0–600, at least one.
- `approxAge` with `birthDate` or `birthDatePrecision` → `400`.
- `birthDate` is `YYYY-MM-DD`, real, not in the future (after normalization); date and precision go together (`400` otherwise).

## 4. Routes (`/chatbot-api/customers/:customerId/pets`)

`customerId` comes from `by-phone` (`customer.customerId`); customers are not unique per phone. Every id in the path must be a UUID (`400`). Unknown or other-sucursal customer → `404 CUSTOMER_NOT_FOUND`; unknown pet or pet of another customer/sucursal → `404 PET_NOT_FOUND`.

### 4.1 `POST …/pets` — create (scope `pets:write`, `X-Idempotency-Key` required)

```http
POST /chatbot-api/customers/5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90/pets
X-Idempotency-Key: pet-migration:5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90:1
Content-Type: application/json

{ "name": "Bruno", "species": "DOG", "breed": "Chihuahua", "size": "SMALL",
  "approxAge": { "months": 10 }, "allergies": "Pollo" }
```

→ `201` complete pet + `"warnings": []`; `createdVia` is `CHATBOT`.

- `name` and `species` required; the rest optional; `null` = absent on create. Unknown members rejected (`400`).
- **Idempotent.** Key per sucursal, 1–200 characters after trimming. Receipt (kind `CUSTOMER_PET_CREATE`) written in the same transaction as the pet: a rejected create (any `4xx`) leaves no receipt and the key can be reused.

| Situation | Answer |
| --- | --- |
| first request | `201` with the pet |
| same key + same body | **`200`** with **the first response byte for byte** (same `id`, `version`, `warnings`, `createdAt`, age fields as computed at the first create). It does not look at the pet again; reread with `GET` for the current state |
| same key + different body | `409 IDEMPOTENCY_KEY_CONFLICT` |
| same key while the first is running | `409 IDEMPOTENCY_KEY_IN_FLIGHT` (retry shortly) |
| key missing, blank or > 200 chars | `400 INVALID_IDEMPOTENCY_KEY` |

The body comparison treats `null` and missing the same and includes the path `customerId` (same key for another customer is a conflict). Same codes as backorders.

Other errors: `400` validation, `404 CUSTOMER_NOT_FOUND`, `422 PET_LIMIT_REACHED`.

### 4.2 `PATCH …/pets/:petId` — edit (scope `pets:write`)

`version` (current, integer ≥ 1) required in the body; other members = create members, optional.

```json
{ "version": 3, "allergies": null, "size": "MEDIUM" }
```

→ `200` complete pet + `warnings`.

- **Absent = unchanged.** The bot never sends fields it does not change (agreement C1).
- **`null` clears** `breed`, `size`, `allergies`, `notes`, `speciesOther`, and the birth date (`"birthDate": null` clears date and precision; only `"birthDatePrecision": null` changes nothing). Blank text also clears.
- `null` on `name` or `species` → `400`.
- Changing `species` away from `OTHER` clears `speciesOther`; moving to `OTHER` needs `speciesOther` (`400`).
- `warnings` carries `PET_NAME_DUPLICATE` only when the name changed.

Check order: body shape (`400`), pet exists (`404`), `version` (`409 PET_VERSION_CONFLICT`), ACTIVE (`422 PET_ARCHIVED`), cross-field rules (`400`).

**Not keyed. Retry after a timeout:** resend with the same `version`; on `409 PET_VERSION_CONFLICT` (`currentVersion` at the root) reread (`GET …/pets?status=ALL`, find by `id`) and treat the edit as done when the values already match; otherwise retry with the new `version`. Same for archive and restore.

### 4.3 `POST …/:petId/archive` — «ya no está» (scope `pets:write`)

```json
{ "version": 3, "reason": "Se fue con otra familia" }
```

`reason` optional (≤ 280, blank → `null`). → `200` pet with `status: "ARCHIVED"`, `archivedAt`, `archivedReason`. Archived again → `422 PET_ARCHIVED`. Leaves the ACTIVE list and `customer.pets`; sale lines and history stay.

### 4.4 `POST …/:petId/restore` (scope `pets:write`)

```json
{ "version": 4 }
```

→ `200` pet `ACTIVE` (archive fields `null`) + `warnings` (may carry `PET_NAME_DUPLICATE`). Active pet → `422 PET_NOT_ARCHIVED`; past 20 → `422 PET_LIMIT_REACHED`.

### 4.5 `DELETE …/:petId?version=N` — real erasure, «olvida mis datos» (scope `pets:delete`)

```http
DELETE /chatbot-api/customers/5c1e9a02-…/pets/8d0e0f6e-…?version=4
```

- `version` is a **query parameter**, never a body; missing or not an integer ≥ 1 → `400`.
- → `204` no body. Stale → `409 PET_VERSION_CONFLICT {currentVersion}`.
- ACTIVE or ARCHIVED. Same transaction: row deleted, its sale lines get `petId = NULL` and snapshots cleared; lines, products and amounts stay, their `pet` reads `null`.
- **`404 PET_NOT_FOUND` on a retry after a timeout means done.**
- Only for an **explicit** «olvida mis datos». «Bruno ya no está» / «olvida a Bruno» is an archive.

Deleting a customer (POS) deletes its pets; their sale lines keep the snapshot with `pet.status: null`.

## 5. Checkout: `sale.items[i].petId`

`POST /chatbot-api/checkouts` accepts an **additive, optional** `petId` (UUID) on each `sale.items[i]`:

```json
{ "sale": { "items": [
    { "productId": "uuid", "variantId": null, "quantity": 2, "unitPriceCents": 45900, "petId": "8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11" },
    { "productId": "uuid", "variantId": null, "quantity": 1, "unitPriceCents": 12000 }
  ], "…": "…" }, "…": "…" }
```

- `petId`: an **ACTIVE pet of the checkout's customer**. `null` = omitted.
- **Idempotency hash:** joins the hash **only when present** (like `backorderId`). A retry under the same key that adds, removes or changes a `petId` gets `409 IDEMPOTENCY_KEY_CONFLICT`. Byte-identical retries replay.
- **One line per product/variant.** Lines of the same product (and variant) must **agree**: two different pets, or one with a pet and one without → `400 INVALID_CHECKOUT_REQUEST`, nothing created. Backorder lines are not merged and are not part of this rule.
- Pet errors: `404 PET_NOT_FOUND`, `422 PET_CUSTOMER_MISMATCH` (pet of another customer; also any `petId` for a customer created by this same checkout via `createIfAbsent`), `422 PET_ARCHIVED`. Nothing created; the key stays retryable. Non-UUID `petId` → `400 INVALID_CHECKOUT_REQUEST`.
- **The checkout response carries no pet.** Read it from the order history (§6).

## 6. Order history: `pet` per line and `?petId=`

`GET /chatbot-api/customers/by-phone/:phone/orders?phoneCountryCode=52[&petId=<uuid>]` (scope `customers:read`). Last 5 confirmed orders, newest first; each `items[]` element gets an additive `pet`:

```json
{ "saleId": "uuid", "folio": "…", "confirmedAt": "2026-11-20T18:02:11.000Z",
  "items": [
    { "productId": "uuid", "variantId": null, "productName": "Croquetas Adulto 18 kg", "variantName": null,
      "quantity": 2, "unitPriceCents": 45900,
      "pet": { "id": "8d0e0f6e-…", "name": "Bruno", "species": "DOG", "status": "ACTIVE" } },
    { "productId": "uuid", "variantId": null, "productName": "Shampoo", "variantName": null,
      "quantity": 1, "unitPriceCents": 12000, "pet": null }
  ],
  "…": "…" }
```

| `pet` | When |
| --- | --- |
| `{ id, name, species, status }` | line assigned a pet; `id`/`name`/`species` from the snapshot; `status` = current (`ACTIVE`/`ARCHIVED`) |
| `{ "id": null, "name": "Bruno", "species": "DOG", "status": null }` | the pet row is gone because its **customer was deleted** |
| `null` | no pet, old lines, and lines of a **really deleted** pet. Never an object of nulls |

- `?petId=<uuid>` keeps orders with at least one line for that pet, each with **all** its lines. Malformed → `400`. Pet not of this customer (or unknown) → `404 PET_NOT_FOUND`; unknown phone **with** `petId` → `404 PET_NOT_FOUND` (without `petId` still `[]`). Pet with no orders → `200 []`.
- **Line order inside an order is not guaranteed**; match lines by `productId` / `variantId`.

## 7. Migration of the bot's existing pets

1. **Dry run first**: for each stored phone call `GET customers/by-phone`, keep `found: true` (customers are not created for pets); optionally compare with `customer.pets`.
2. Migrate only numbers that resolve to a Customer; use `customer.customerId`.
3. Key `pet-migration:<customerId>:1` (`:2`, `:3`… in a stable order): rerun same body → `200` replay; changed body → `409 IDEMPOTENCY_KEY_CONFLICT`; `IDEMPOTENCY_KEY_IN_FLIGHT` → retry.
4. Stored age text → `approxAge` (or `birthDate` + precision). **Unparseable → `notes`** (≤ 500), no age.
5. `422 PET_LIMIT_REACHED` → log and continue.
6. Tens of pets: a loop is fine; `write` bucket applies (`429` + `Retry-After`).

## 8. What does not change

`by-phone` without `pets:read`, `PUT customers/by-phone`, the checkout response and every request without `petId`, the feed and the other routes. Old orders have `pet: null` on every line.

## 9. Errors

| HTTP | `error` (+ detail) | When |
| --- | --- | --- |
| 400 | per-field validation | lengths, enums, `speciesOther`, birth date rules, `approxAge` + `birthDate`, `null` on `name`/`species`, missing/invalid `version`, unknown members, non-UUID ids, bad `?status=` |
| 400 | `INVALID_IDEMPOTENCY_KEY` | create without a valid key |
| 400 | `INVALID_CHECKOUT_REQUEST` | same product/variant lines disagree on the pet, or non-UUID `petId` |
| 404 | `CUSTOMER_NOT_FOUND` | unknown customer in the path |
| 404 | `PET_NOT_FOUND` | unknown/foreign/deleted pet; `?petId=` on orders; checkout `petId` |
| 409 | `PET_VERSION_CONFLICT {currentVersion}` | stale `version` on PATCH, archive, restore, DELETE |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | create (or checkout) key reused with another body |
| 409 | `IDEMPOTENCY_KEY_IN_FLIGHT` | create key held by a running request |
| 422 | `PET_ARCHIVED` | PATCH/archive of an archived pet; checkout with an archived pet |
| 422 | `PET_NOT_ARCHIVED` | restore of an active pet |
| 422 | `PET_LIMIT_REACHED` | 21st active pet |
| 422 | `PET_CUSTOMER_MISMATCH` | checkout `petId` of another customer |
| 403 | — | missing scope |
| 500 | `CUSTOMER_PET_REQUEST_FAILED` | unknown failure |

`PET_NAME_DUPLICATE` is a **warning**, never an error.

## Differences from the proposal

- `ageLabel` under one month is `«menos de 1 mes»` without `«~»`.
- Checkout lines of the same product with different pets (or pet + no pet) → `400 INVALID_CHECKOUT_REQUEST`.
- `?petId=` on order history also answers `404 PET_NOT_FOUND` for an unknown phone.

## Deploy checklist

1. Backend migrations, in order: `20261123000000_customer_pets` (index on `sale_items` blocks writes briefly; low traffic) and `20261123010000_customer_pet_bot_receipt_kind`. **The bot's pet create must not go live before the second one** (older database → `500`).
2. Add `pets:read`, `pets:write`, `pets:delete` to the chatbot `svc_` credential (exact strings).
3. Chatbot parsers must ignore unknown members (order lines gain `pet`, `by-phone` may gain `customer.pets`). **Deploy the backend after the bot tolerates them.**
4. Existing routes, scopes, feed events and checkout requests without `petId` are unchanged.
