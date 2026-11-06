# Live contract smoke test

`scripts/e2e/contract-smoke.ts` runs the real `ChatbotApiHttpClient` (no Nest app) against a running backend and checks that every real response passes our DTO parsers.

**It writes data. Run it only against a DEV backend.** Each run creates a test customer (`E2E Prueba`, phone `52 55 0000 XXXX`), a confirmed pickup sale (this lowers stock by 1), a DELIVERY_ZONE requester for ZIP 64000 when that zone is PENDING, and a PENDING transfer receipt.

## Steps

1. `searchCatalog` (`croqueta`, then broader queries): picks a product or variant that has a price and sellable stock of at least 1.
2. `getStock` on that product.
3. `evaluateCart` with a fresh test phone, plus the line checks that `minimal-cart.service` applies.
4. `getCustomerCheckoutContext`: expects `not_found`.
5. `createShippingQuote` to `64000 / Nuevo León / Monterrey / Centro`. If the zone is `PENDING`, it then calls `submitDeliveryZoneIntake` and `getDeliveryZoneRequester`. A 404, 409, 422 or 503 error here is printed and the run continues, because those come from backend data or config.
6. `createCheckout` for store pickup, then `getCheckoutStatus` with the same key. Both must return the same sale.
7. `uploadReceipt` with a 1x1 PNG, then again with the same key. Both must return the same receipt.
8. `getReceiptOutcome`: expects `PENDING`.

The script prints one line per step and stops at the first unexpected failure. `CONTRACT_MISMATCH` means a response did not fit our DTOs. For those failures it prints only key names and JSON types, never values.

The client has no runtime parser for catalog search, stock or cart evaluation. For those three, the script checks exact keys against the TypeScript interfaces in `src/chatbot-api/domain/dtos/`.

## Running it

Required env vars: `CHATBOT_API_BASE_URL`, `SERVICE_KEY`, `CHATBOT_API_BRANCH_ID`, `CHATBOT_API_CASHIER_USER_ID`.

**Rule for `SERVICE_KEY`:** never print it, echo it, export it in your shell profile, or write it to a file. Load it from `.env` inside the same command that runs the script:

```sh
SERVICE_KEY="$(grep '^SERVICE_KEY=' .env | head -1 | cut -d= -f2- | tr -d "\"' \r")" \
CHATBOT_API_BASE_URL=http://localhost:3003 \
CHATBOT_API_BRANCH_ID=<dev branch uuid> \
CHATBOT_API_CASHIER_USER_ID=<dev bot cashier user uuid> \
pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/contract-smoke.ts
```

Exit code `0` means every step passed. `1` means a step failed. `2` means an env var is missing.

The test phone changes every minute. If you run the script twice in the same minute, step 4 finds the customer that the first run created and the run stops. Wait a minute before running it again.

## Delivery scenario

Run it with `SCENARIO=delivery` (or pass `delivery` as the first argument). Without it, the script runs the pickup scenario above.

It uses the dev zones of Sucursal Centro and product `45935cb9-7370-4148-8d6a-1a63b625c2b8` (croquetas 18 kg, the only product with packaging configured). The test phone is `52 55 1000 XXXX`, so it never clashes with the pickup scenario.

**It writes data:** a customer (`E2E Envio`), a saved address (`Calle Prueba 1`, 04000), and one confirmed delivery sale (this lowers stock by 1).

1. `searchCatalog` finds the product, then `evaluateCart` prices 1 unit with the fresh phone.
2. `createShippingQuote` for each zone (loose destination):

   | ZIP   | Zone         | Checks                                                                                                                                       |
   | ----- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
   | 03100 | FREE         | `option` null, `customerChargeCents` 0                                                                                                       |
   | 04000 | SURCHARGE    | `option` null, `costCents` 6900, credit rule ($120 per unit over $500, may be capped at cost), `customerChargeCents` = max(0, cost − credit) |
   | 14000 | CARRIER_ONLY | `option` has carrier and service                                                                                                             |
   | 12000 | DENIED       | `quoteId` null                                                                                                                               |

   A broken check prints a `DEVIATION` line and the run goes on. If CARRIER_ONLY fails, the script prints the status, error code and body key names, then goes on.

3. `createCheckout` for delivery with the SURCHARGE quote, built the same way `minimal-order.service` builds it. `expectedTotalCents` is the merchandise plus `customerChargeCents`. Then `getCheckoutStatus` with the same key must return the same sale.
4. `createCheckout` again with the same quote and a new key. It must fail with 409 `SHIPPING_QUOTE_ALREADY_USED`, and `getCheckoutStatus` for that key must answer `not_observed`.
5. The CARRIER_ONLY quote, if any, is printed only. It is never used for a sale, so dev stock is kept.

The last line is `done` or `done (with deviations)` with the list. If the client's strict parser rejects a quote or checkout body, the script prints a `PARSER_PATHS` line (paths and key names only) and stops.

```sh
SERVICE_KEY="$(grep '^SERVICE_KEY=' .env | head -1 | cut -d= -f2- | tr -d "\"' \r")" \
CHATBOT_API_BASE_URL=http://localhost:3003 \
CHATBOT_API_BRANCH_ID=<dev branch uuid> \
CHATBOT_API_CASHIER_USER_ID=<dev bot cashier user uuid> \
SCENARIO=delivery \
pnpm exec ts-node -r tsconfig-paths/register scripts/e2e/contract-smoke.ts
```
