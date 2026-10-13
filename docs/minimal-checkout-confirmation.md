# Local checkout confirmation

`MinimalCheckoutConfirmation` is a pure (no SDK/HTTP/store/Nest) domain unit that gates a **local-only** customer/delivery confirmation for the minimal checkout route (T3 Unit A). It reports which required fields are still missing, offers a server-owned summary, turns a strict sender-bound affirmative into a server-owned **candidate**, and finalizes locally only after the caller reports a real store checkpoint. It never registers a customer, edits a saved address, creates an order, reserves stock or activates shipping.

## Quick path (coordinator integration)

1. Read the trusted dashboard draft and revalidate any selected **saved** address against the backend freshness `version`.
2. `prepare({ senderId, inboundEvent, draft })` → `offer` (summary + opaque `reference` + `onSent`) or `blocked`.
3. Send `reply`; call `onSent()` **only after the transport accepted it**.
4. On the next inbound turn, `consume({ senderId, text, inboundEvent, draft })` → `candidate` / `reoffer` / `handled` / `null`.
5. For a `candidate`, run the existing `ConversationStore.commitMinimalCheckoutDraft(senderId, rawExpected, candidate.draft, lastMessageAt)` CAS.
6. `finalize({ senderId, candidate, committed })` with the **real** CAS result.
7. Only `confirmed` means the local confirmation succeeded — still not an order and not a final purchase.

## Scope and non-goals

| In scope (this unit)                                                        | Out of scope (coordinator / later slices)                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| S7 non-blank readiness gate for new **and** saved addresses                 | Editing or persisting a saved address                             |
| Server-owned summary + volatile pending bound to exact content and revision | Sending WhatsApp messages (transport)                             |
| Strict deterministic affirmative → candidate ticket                         | The store CAS itself and backend freshness revalidation           |
| Local finalization after a reported successful checkpoint                   | Customer registration, sale creation, payment, shipping providers |
| Observable missing-fields and local-binding state                           | Reading the backend / `checkout-context`                          |

This unit holds **volatile** state only. A confirmed draft is not a created order or a confirmed final purchase.

## Readiness gate (S7)

Applied identically to `new` and `saved` drafts; a saved snapshot is never edited to satisfy the gate. A value counts as provided when it is a string with at least one non-whitespace character.

| Field                                                                     | Required | Notes                                    |
| ------------------------------------------------------------------------- | -------- | ---------------------------------------- |
| `firstName`                                                               | yes      | `lastName` is optional                   |
| `street`                                                                  | yes      |                                          |
| `exteriorNumber`                                                          | yes      | `S/N` is a valid value                   |
| `neighborhood`                                                            | yes      |                                          |
| `zipCode`                                                                 | yes      |                                          |
| `state`                                                                   | yes      |                                          |
| `city` **or** `municipality`                                              | one      | city-only or municipality-only is enough |
| `lastName`, `label`, `interiorNumber`, `visualReferences`, `carrierPhone` | no       | optional                                 |

Partial drafts stay valid for collection, but `prepare` returns `blocked` with the ordered `missing` list instead of an offer.

## Volatile lifecycle

| Boundary           | Behavior                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Pending TTL        | Five minutes (`MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS`), mirroring RESTOCK.                                                          |
| Binding            | Trusted sender, exact canonical content + `revision`, trusted source phone id, origin message id, fresh opaque reference.          |
| Arming             | Only the same live, unexpired pending can be armed via its identity-checked `onSent`. A replaced/expired callback is a no-op.      |
| Consent            | Only a whole `SI`/`SÍ` with optional outer spaces/tabs and one optional trailing period. No model inference, no mixed correction.  |
| Candidate          | A strict, trusted, fresh, armed affirmative whose current draft still matches the binding. It is a ticket, **not** a confirmation. |
| Unhandled (`null`) | No pending, foreign sender, non-affirmative text or an unrelated turn — the coordinator lets other routes handle it.               |
| `handled`          | Affirmative that cannot confirm yet (unarmed, stale, foreign phone) or a changed draft (`MINIMAL_CHECKOUT_CHANGED_REPLY`).         |
| Draft change       | Any content or `revision` change (a same-revision content change too) invalidates the pending and any local confirmation.          |
| Non-confirmation   | A `false` checkpoint never finalizes and never retries; a new presentation supersedes pending and confirmation.                    |
| Restart            | The presentation/confirmation is instance-scoped and lost. The durable draft survives elsewhere, so re-present and re-confirm.     |

## Composition duties (coordinator-owned)

This unit is pure, so it cannot and does not:

1. Read or write the store, or prove compare-and-set. Revalidate any selected **saved** address freshness before trusting/confirming.
2. Run the checkpoint. Re-read the **raw** expected draft and call `commitMinimalCheckoutDraft(senderId, rawExpected, candidate.draft, lastMessageAt)`, then pass that exact result to `finalize`.
3. Send messages or own the transport. Invoke `onSent()` only after the transport accepted the summary.
4. Persist confirmation metadata. Missing-field and local-binding state is exposed through public methods, never written as generic sibling flags.

## Public API

```ts
import { MinimalCheckoutConfirmation } from './minimal-checkout-confirmation';

const confirmation = new MinimalCheckoutConfirmation(/* { now? } test seam */);

confirmation.prepare({ senderId, inboundEvent, draft });
// -> { kind: 'offer', reply, reference, onSent } | { kind: 'blocked', reason, missing }

confirmation.consume({ senderId, text, inboundEvent, draft });
// -> { kind: 'candidate', reference, draft } | { kind: 'reoffer', reply, onSent }
//    | { kind: 'handled', reply } | null

confirmation.finalize({ senderId, candidate, committed });
// -> { kind: 'confirmed', reply } | { kind: 'not_confirmed', reply }

confirmation.status(senderId);
// -> { stage: 'pending', reference, revision, armed, expiresAt }
//    | { stage: 'confirmed', reference, revision } | null

confirmation.readiness(senderId, rawDraft);
// -> { ready, missing } | null

evaluateMinimalCheckoutReadiness(validatedDraft); // pure S7 helper
renderMinimalCheckoutConfirmation(validatedDraft); // server-owned summary
```

`candidate.draft` is a detached validated copy of the presented draft; mutating it cannot grant authority — `finalize` re-normalizes it and requires the exact reference plus canonical content + revision.

## Checklist

- [ ] Saved-address freshness revalidated before confirmation (coordinator).
- [ ] `onSent()` called only after the summary was accepted by the transport.
- [ ] CAS run with the raw expected value and the candidate draft; its real result passed to `finalize`.
- [ ] No customer/address/order/payment/shipping side effect introduced.
- [ ] No order, registration or final-purchase claim made from a local confirmation.

## Next step

Wire this unit behind the existing minimal-route coordinator with the trusted WhatsApp phone parser and optional DI, preserving the sender allowlist and the EXPIRATION/RESTOCK/cart acknowledgement priorities.
