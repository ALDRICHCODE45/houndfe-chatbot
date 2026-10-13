# Minimal checkout coordinator (T3B/T3C)

`MinimalCheckoutService` wires the T3A domains (`MinimalCheckoutConfirmation`, `MinimalCheckoutAddressReferences`) into the minimal SDK route. It lets an allowlisted WhatsApp sender pick a saved address or dictate a new one, then confirm the delivery data **locally**.

A local confirmation is not an order, not a customer registration and not a shipping activation.

## What the customer can do

| Step                 | SDK tool                                              | Server behavior                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find saved data      | `lookupCheckoutCustomer({ nextPageRef })`             | Reads `GET /chatbot-api/customers/checkout-context` for the trusted sender phone. Returns `unique` (opaque `addressRef`s + summaries), `not_found`, `ambiguous`, or `lookup_unavailable`. One bounded page per call. |
| Pick a saved address | `selectCheckoutAddress({ addressRef })`               | Only a live server-issued reference works. Stores an exact snapshot in the durable draft.                                                                                                                            |
| Dictate new data     | `updateCheckoutDetails({ ...fields, useNewAddress })` | `null` keeps a field. Saved addresses are never edited: address fields on a saved selection need `useNewAddress: true`. Values are trimmed and bounded like the backend customer DTO.                                |
| Ask to confirm       | `confirmCheckoutDetails({})`                          | Server-owned reply: the summary (armed by `onSent`), the missing-data list, or a re-select request.                                                                                                                  |
| Confirm              | customer replies `SÍ`                                 | Consumed in `tryHandle` before the SDK run.                                                                                                                                                                          |

The tools exist only when the minimal cart is enabled and the store implements `commitMinimalCheckoutDraft`. Without `MinimalCheckoutService` the route is unchanged.

## Confirmation rules

1. The summary is offered only when the S7 gate passes: name, street, exterior number or `S/N`, neighborhood, ZIP code, state, and city or municipality.
2. Only a strict `SÍ`/`SI` (optional final period) from the same sender and receiving phone, after the summary was sent, can confirm. A mixed message such as `Sí, pero cambie la calle` goes to the model.
3. Any committed draft change invalidates the summary and revokes an earlier local confirmation. A no-op update keeps it. A `SÍ` to an outdated summary gets `MINIMAL_CHECKOUT_CHANGED_REPLY` followed by the updated summary, which must be confirmed again.
4. A saved address is re-read with its original bounded page query before the summary and again before acceptance. A changed version or a lost reference asks the customer to choose again (`MINIMAL_CHECKOUT_RESELECT_REPLY`); a failed read gets `MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY`. Neither confirms.
5. Acceptance runs one `commitMinimalCheckoutDraft` CAS with the same validated draft. `false` never retries and never confirms: the customer gets `MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY` followed by a fresh summary.
6. When no fresh summary can be offered (missing data, re-select, unavailable), only that reason is sent.

`MinimalCheckoutService.confirmationStatus(senderId)` exposes the volatile state (`pending`, `confirmed` or `null`). Using a confirmed draft for an order is out of scope here; the preflight that re-checks it belongs to the order-creation slice.

## Reply priority in one SDK run

EXPIRATION > RESTOCK > checkout presentation (appended after any cart acknowledgement or invalid-cart clarification) > cart reply > model text. When RESTOCK or EXPIRATION wins, the checkout summary is not sent and stays unarmed.

## Restart behavior

The draft is durable. Address references, the presented summary and the local confirmation are in memory. After a restart a `SÍ` to an old summary is an ordinary message for the model; the customer must ask for the summary again, and a saved address must be looked up and selected again.

## Never called by this route

Customer upsert, address mutations, sales, reservations, payments and shipping providers. Creating an order from a confirmed saved address is a separate, default-off capability: see `docs/minimal-order-placement.md`.

## Check

```sh
node_modules/.bin/jest src/llm-agent/application/minimal-checkout.service.spec.ts
```
