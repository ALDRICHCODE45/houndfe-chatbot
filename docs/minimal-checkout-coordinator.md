# Minimal checkout coordinator (T3B/T3C)

`MinimalCheckoutService` wires the T3A domains (`MinimalCheckoutConfirmation`, `MinimalCheckoutAddressReferences`) into the minimal SDK route. It lets an allowlisted WhatsApp sender pick a saved address or dictate a new one, then confirm the delivery data **locally**.

A local confirmation is not an order, not a customer registration and not a shipping activation.

## What the customer can do

| Step                 | SDK tool                                              | Server behavior                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find saved data      | `lookupCheckoutCustomer({ nextPageRef })`             | Reads `GET /chatbot-api/customers/checkout-context` for the trusted sender phone. Returns `unique` (opaque `addressRef`s + summaries), `not_found`, `ambiguous`, or `lookup_unavailable`. One bounded page per call. |
| Pick a saved address | `selectCheckoutAddress({ addressRef })`               | Only a live server-issued reference works. Stores an exact snapshot in the durable draft.                                                                                                                            |
| Dictate new data     | `updateCheckoutDetails({ ...fields, useNewAddress })` | `null` keeps a field. With a saved selection, `useNewAddress: false` corrects only supplied fields; `true` starts a new address. Values are trimmed and bounded like the backend customer DTO.                       |
| Ask to confirm       | `confirmCheckoutDetails({})`                          | Server-owned reply: the summary (armed by `onSent`), the missing-data list, or a re-select request.                                                                                                                  |
| Confirm              | customer replies `SÍ`                                 | Consumed in `tryHandle` before the SDK run.                                                                                                                                                                          |

The tools exist only when the minimal cart is enabled and the store implements `commitMinimalCheckoutDraft`. Without `MinimalCheckoutService` the route is unchanged.

## Correct a selected saved address

For “el codigo postal esta mal, el correcto es: 55635”, the model calls
`updateCheckoutDetails` with `zipCode: '55635'`, `useNewAddress: false` and
`null` for every other field, then `confirmCheckoutDetails` in the same turn.
The server keeps the other snapshot fields and presents the corrected delivery
summary for a new **SÍ**. If the customer says a value is wrong but supplies no
replacement, ask for the correct value; never ask them to confirm the wrong data.

The durable `savedCorrected` choice holds the exact base snapshot (`id` and
`version` included) and the full corrected fields. Later corrections accumulate;
restoring all original values returns to plain `saved`. Name corrections keep
the existing behavior. Base freshness is revalidated just like `saved`, including
after restart. Nothing is written upstream until the atomic order transaction;
see [order placement](minimal-order-placement.md#atomic-checkout-switch).

## Confirmation rules

1. The summary is offered only when the S7 gate passes: name, street, exterior number or `S/N`, neighborhood, ZIP code, state, and city or municipality.
2. Only a strict `SÍ`/`SI` (optional final period) from the same sender and receiving phone, after the summary was sent, can confirm. A mixed message such as `Sí, pero cambie la calle` goes to the model.
3. Any committed draft change invalidates the summary and revokes an earlier local confirmation. A no-op update keeps it. A `SÍ` to an outdated summary gets `MINIMAL_CHECKOUT_CHANGED_REPLY` followed by the updated summary, which must be confirmed again.
4. A saved address is re-read with its original bounded page query before the summary and again before acceptance. A changed version or a lost reference asks the customer to choose again (`MINIMAL_CHECKOUT_RESELECT_REPLY`); a failed read gets `MINIMAL_CHECKOUT_LOOKUP_UNAVAILABLE_REPLY`. Neither confirms.
5. Acceptance runs one `commitMinimalCheckoutDraft` CAS with the same validated draft. `false` never retries and never confirms: the customer gets `MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY` followed by a fresh summary.
6. When no fresh summary can be offered (missing data, re-select, unavailable), only that reason and its next step are sent. With no draft, the customer is asked to say «quiero comprar» to see saved addresses or dictate a new address.
7. The delivery summary includes the interior number when present, keeps the local-only scope warning, and ends with `Responda "SÍ" para confirmar estos datos, o dígame qué quiere cambiar.` Acceptance ends with `Para continuar, dígame «hacer pedido» y le mostraré el resumen con el total.` Delivery consent never substitutes for order consent.

After a successful address selection, or an update that completes the required fields, the model is instructed to call `confirmCheckoutDetails` in the **same response**, never to author the confirmation itself. While an address is selected or delivery details are being collected, it must not call `reviewCheckout`.

`MinimalCheckoutService.confirmationStatus(senderId)` exposes the volatile state (`pending`, `confirmed` or `null`). Using a confirmed draft for an order is out of scope here; the preflight that re-checks it belongs to the order-creation slice.

## Reply priority in one SDK run

EXPIRATION > RESTOCK > checkout presentation (appended after any cart acknowledgement or invalid-cart clarification) > cart reply > model text. A `reviewCheckout` acknowledgement is dropped when a checkout/order presentation is produced in the same run, in either tool order; real cart mutation acknowledgements are preserved. When RESTOCK or EXPIRATION wins, the checkout summary is not sent and stays unarmed.

If `prepareOrder` is blocked only because delivery is unconfirmed, it reuses `MinimalCheckoutService.prepareConfirmation`, exactly like `confirmCheckoutDetails`: a ready draft gets the server-owned delivery summary, an incomplete draft gets the missing-field list, and an absent draft gets the address-entry next step. The existing one-presentation-per-run guard and transport `onSent` still apply; no second confirmation state machine is introduced.

## Restart behavior

The draft is durable. Address references, the presented summary and the local confirmation are in memory. After a restart a `SÍ` to an old summary is an ordinary message for the model; the customer must ask for the summary again, and a saved address must be looked up and selected again.

## Never called by this route

Customer upsert, address mutations, sales, reservations, payments and shipping providers. Creating an order from a confirmed saved address is a separate, default-off capability: see `docs/minimal-order-placement.md`.

## Check

```sh
node_modules/.bin/jest src/llm-agent/application/minimal-checkout.service.spec.ts
```
