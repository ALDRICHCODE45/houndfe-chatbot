# Minimal checkout coordinator (T3B)

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
3. Any draft change after the summary invalidates it (`MINIMAL_CHECKOUT_CHANGED_REPLY`).
4. A saved address is re-read with its original bounded page query before the summary and again before acceptance. A changed version or a lost reference asks the customer to choose again.
5. Acceptance runs one `commitMinimalCheckoutDraft` CAS with the same validated draft. `false` never retries and never confirms.

## Reply priority in one SDK run

EXPIRATION > RESTOCK > checkout presentation (appended after any cart acknowledgement) > cart reply > model text.

## Restart behavior

The draft is durable. Address references, the presented summary and the local confirmation are in memory. After a restart the customer sees a fresh summary before confirming, and a saved address must be looked up and selected again.

## Never called by this route

Customer upsert, address mutations, sales, reservations, payments and shipping providers.

## Check

```sh
node_modules/.bin/jest src/llm-agent/application/minimal-checkout.service.spec.ts
```
