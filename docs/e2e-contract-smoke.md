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
