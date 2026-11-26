# Conversation eval

A live harness that measures conversation quality on the real customer route, `MinimalCatalogAgentService`. It uses the same system prompt, tools, deterministic confirmation gates, cart, checkout, shipping and order services as production. Only the backend is replaced: an in-memory pet-store fake (`fixtures/`) stands in for the `chatbot-api`, including the customer-pets routes. Run it before and after a change to compare. The agent is built in `harness.ts`; the SDK spec `src/llm-agent/application/eval-harness-pets.sdk.spec.ts` builds the same agent with a scripted model.

## Run

```bash
# No network: a canned model searches once, then replies. Checks the wiring.
pnpm eval:conversation --dry-run

# Live against OpenAI. Load .env yourself; the script reads process.env only.
set -a; . ./.env; set +a
EVAL_MODEL=gpt-4.1-mini EVAL_MAX_USD=1.00 pnpm eval:conversation

# Only some scenarios
EVAL_SCENARIOS=buy-free-zone,decline pnpm eval:conversation

# Multi-pet scenarios only (11 turns)
EVAL_SCENARIOS=returning-customer,pets-which-pet,pets-allergy-forget,pets-reorder pnpm eval:conversation
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required for a live run. |
| `EVAL_MODEL` | `LLM_MODEL`, then `gpt-4.1-mini` | OpenAI model id. An `openai/` prefix is stripped. |
| `EVAL_MAX_USD` | `1.00` | Hard spend cap for one run. |
| `EVAL_SCENARIOS` | all | Comma-separated scenario ids from `scenarios.ts`. |
| `LLM_MAX_STEPS`, `LLM_HISTORY_TURNS` | `4`, `12` | Same meaning as in production. |
| `EVAL_VERBOSE` | off | Shows the service's Nest logs. |

## Budget

Token usage comes from each `generateText` result and is priced with the `PRICES` table in `conversation-eval.ts` (gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini; cached input is priced separately). **Check those prices against the OpenAI pricing page before you rely on the totals.** A live run with a model missing from the table refuses to start.

The harness checks the budget before every turn and before every model call. A turn only starts if `spent + largest turn so far` still fits under the cap; until a turn has been measured, it assumes 40k input and 1k output tokens. When the cap would be crossed, the run stops, still writes the transcript, and exits 0.

## Output

- `scripts/eval/out/<timestamp>.md` (gitignored): for each turn, the customer text, the product photos sent before the reply (`🖼️ Imagen: <caption> <url>`; fixture products have placeholder JPEG URLs), the bot reply, the tools called, the number of LLM calls and their cost, and the backend activity (searches, quotes, `ORDER CREATED folio …`). It also gives a gate label: `deterministic gate (no LLM call)`, `delivery confirmation`, `order summary` or `order placed`.
- The console prints a summary table (per scenario: fails, warnings, orders, cost) and fail/warn totals for each check.

## Checks

The checks are deterministic heuristics; there is no LLM judge. Treat them as flags to read in the transcript, not as proof.

| Check | Fail | Warn |
| --- | --- | --- |
| `emoji` | Reply has an emoji, but neither the customer's last message nor at least 2 of their last 3 had one (same rule as the service's emoji guard). | The customer's last message had an emoji; the reply has none. |
| `register` | Expected tú, reply uses only usted (or the reverse). Expected register starts as usted and follows the customer's latest tú/usted markers. | Reply mixes both. |
| `slang` | Voseo, vosotros forms or Mexican slang (`güey`, `chido`, `neta`, …). | — |
| `refusal` | The literal `esa función aún no está disponible` on a supported request. | Missing on a turn marked `expected`. |
| `persona` | Mentions technology/retail/punto de venta, or a turn marked `expectPersona` does not mention mascotas. | — |
| `leak` | Internal text (`selectionRef`, `productId`, `herramienta`, operator copy such as "Primero registra la venta"). | — |
| `species` | The customer asked about one species (their latest message naming one: a word, 🐱/🐶, or the species of a product photo) and the reply names only other species (e.g. dog food offered for a cat request, including the turn after). | — |
| `orders` | At the end, the number of distinct checkout idempotency keys ≠ `expectOrders`. Confirm scenarios expect exactly 1; decline and denied-zone scenarios expect 0. | — |
| `expect` | — | The reply does not match the turn's `expectReply` heuristic (e.g. `returning-customer`: tú after the restart, adult large-breed food for Luna). |
| `reply` | The reply does not match the turn's `requireReply` (e.g. `«¿Para quién es?»`, `«(para Max)»`). | — |
| `interactive` | The turn sent no buttons/list, or its transcript line does not match `expectInteractive`. | — |
| `backend` | None of the turn's backend calls matches one of the turn's `expectBackend` patterns (pet store writes, order-history reads). | — |

## Customer memory (S1) and pets

Each scenario gets its own world (`createEvalWorld` in `harness.ts`): an in-memory customer-profile store (shared by the agent, the order service and the prospects' local pet list, like the production `customer_profiles` table), an in-memory conversation-gate store (the durable gates, including `pet_choice`; one `ConversationGates` shared by the agent and the order service, as in production), the backend fake and its pets. A turn with `restartBefore: true` builds a new agent and session (a bot restart) over the same world; the transcript marks it `🔄 (bot restart)`.

Pets go through the real `CustomerPetsService` (multi-pet T4–T6b): backend pets for a customer, a local list for a prospect uploaded after the checkout creates the Customer. The backend writes (`createPet`, `patchPet`, `archivePet`, …) appear on the turn's `Backend:` line; the harness lets the reply path's background pet capture finish before reading it. The expected register carries over the restart, the emoji rule restarts with the new session. `returning-customer` uses this: session 1 is casual tú with emojis and mentions Luna (created in the backend: the customer exists); session 2 starts with "hola" and reads Luna back from the by-phone lookup.

Multi-pet scenarios (customer with Max, labrador ~3 años, and Bruno, chihuahua ~10 meses):

- `pets-which-pet`: «busco croquetas para mi perro» → «¿Para quién es?» with buttons for both pets; «para Max» continues the request (a catalog search); the next cart line shows «(para Max)».
- `pets-allergy-forget`: «Max es alérgico al pollo» → `patchPet` with the allergy; «Bruno ya no está…» → `archivePet`.
- `pets-reorder`: «lo mismo de siempre para Max» → order history read with `?petId=` of Max.

## Fixtures

- `fixtures/catalog.ts` has 13 products: dog and cat food from several brands and sizes (including "Croquetas Naturales Sin Grano de Salmón y Camote… 18 kg" at $1,599), cat litter, toys and collars. Products have variants and every stock status: available, low_stock, out_of_stock and not_managed.
- `fixtures/fake-api.ts`:
  - Search is token overlap.
  - `evaluateCart` charges list prices.
  - Customer lookup returns either a new customer (`not_found`) or an existing customer with one saved address.
  - An existing customer may have backend pets (`pets` in the fixture customer); its order history then starts with an order whose lines are for them (Nupec 18 kg for the first pet, Royal Canin Mini 2 kg for the second). `getOrderHistory` with `petId` keeps the orders with a line for that pet.
  - Shipping by ZIP: `03100` FREE, `04000` SURCHARGE $69, `12000` DENIED, anything else CARRIER_ONLY with the $120 credit rule.
  - Checkout is idempotent and returns folio `EV-000n`.
  - Payment details are fixed.
  - Calls outside the eval reject, so they show up in the transcript.
- `fixtures/fake-pets-client.ts`: the customer-pets routes in memory (docs/contracts/customer-pets-bot-contract.md): list (ACTIVE by name, ARCHIVED, ALL), idempotent create (replay / `IDEMPOTENCY_KEY_CONFLICT`), PATCH / archive / restore / delete with `version` +1 per write, `PET_VERSION_CONFLICT`, `PET_ARCHIVED`, `PET_NOT_ARCHIVED`, `PET_NOT_FOUND`, `CUSTOMER_NOT_FOUND`, the 20-active limit and the `PET_NAME_DUPLICATE` warning. `evalCustomerLookup` is the by-phone lookup the pet store reads (a new customer is found once a checkout of the scenario created it). Spec: `src/llm-agent/application/eval-pets-client.spec.ts`.
- Image turns use the T4 text format (`imageTurn` in `scenarios.ts`). If `buildProductImageTurnText` changes, update `imageTurn` to match.

## Limits

- Scripts are fixed. If the model takes a different number of turns, later lines may land on a different step. Read the transcript, not just the table. The extra trailing affirmatives in confirm scenarios are deliberate: they also check that no duplicate order is created.
- Restock and expiration gates are not wired, so out-of-stock turns never offer a restock request.
- The register and emoji checks are regex heuristics and can misfire, for example on third-person "su"/"le".
