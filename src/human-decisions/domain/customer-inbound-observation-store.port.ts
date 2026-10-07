import type { CustomerInboundObservation } from './customer-inbound-observation';

/** First-persisted or replay observation of one verified inbound event; neither
 * `recorded` nor `replay` proves provenance, latestness or send authority. */
export type CustomerInboundObservationRecord =
  | Readonly<{
      kind: 'recorded' | 'replay';
      observation: CustomerInboundObservation;
    }>
  | Readonly<{ kind: 'hold' }>;

/** Latest observation for one exact sender + receiving phone. `missing` is a
 * proven absence for the query, distinct from an unreadable `hold` row. */
export type CustomerInboundObservationLatest =
  | Readonly<{ kind: 'found'; observation: CustomerInboundObservation }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'hold' }>;

/**
 * Inert persistence port: no wiring, capture/send authority, retry or caller
 * transaction. `record` retains the FIRST PERSISTED verified-ingress observation
 * keyed by the immutable `(receivingPhoneNumberId, messageId)` identity. An exact
 * immutable event replay returns the original stored observation even when the
 * retry's `observedAt` differs and never refreshes it; an immutable-field
 * conflict holds. First persisted is not globally earliest arrival under
 * concurrency. `readLatest` selects by original provider time, with `messageId`
 * as a deterministic tie-break, for the requested sender and phone, never replay
 * or observation time. Invalid input holds before any I/O; a malformed persisted
 * row holds, never a fabricated result. SQL failures/uncertainty propagate once
 * without retry, since a write may have committed; operations are standalone
 * pool calls, not a caller-owned transaction. Accepting a typed observation here
 * owns neither capture nor sending.
 */
export interface CustomerInboundObservationStore {
  record(input: unknown): Promise<CustomerInboundObservationRecord>;
  readLatest(
    senderId: string,
    receivingPhoneNumberId: string,
  ): Promise<CustomerInboundObservationLatest>;
}
