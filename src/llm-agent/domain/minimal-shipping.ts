/**
 * Pure minimal-route shipping, owned exclusively by `minimalCart.shipping`.
 * The backend chooses the carrier, computes the credit and signs `quoteId`
 * with `expiresAt` (S1-S3); this record stores that answer verbatim and pins
 * it to the cart lines (`cartPin`: identity, quantity, unit price and
 * evaluated line total) and the confirmed destination (`destinationPin`:
 * saved id/version or a SHA-256 of confirmed new-address fields). Only a
 * deliverable, unexpired quote whose pins still match may back an order.
 * No clock, store, transport, framework or SDK dependency.
 *
 * LEGACY: records with an `approval` sub-object came from the per-quote human
 * approval flow. They still parse so old slots and the approval code keep
 * working until U5 deletes them; they never back an order.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MinimalCheckoutDraftAddress } from '../../conversation/domain/minimal-checkout-draft';
import type { ShippingQuoteResponse } from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { calculateShippingCredit } from '../../shipping/domain/shipping-credit';
import {
  normalizeShippingQuoteQuotedResult,
  type ShippingQuoteQuotedResult,
} from '../../shipping/domain/shipping-quote.result';

export const MINIMAL_SHIPPING_TTL_MS = 30 * 60 * 1000;
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const iso = z.iso.datetime({ offset: true });
const cartLineSchema = z.strictObject({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  quantity: money.refine((value) => value > 0),
  unitPriceCents: money,
  finalPriceCents: money,
});
const cartLinesSchema = z
  .array(cartLineSchema)
  .min(1)
  .refine((lines) =>
    lines.every(
      (line, index) =>
        !lines
          .slice(0, index)
          .some(
            (other) =>
              line.productId === other.productId &&
              line.variantId === other.variantId,
          ),
    ),
  );
const approvalSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not_requested') }),
  z.strictObject({ state: z.literal('pending'), requestId: label }),
  z.strictObject({
    state: z.literal('approved'),
    requestId: label,
    decidedAt: iso,
  }),
  z.strictObject({
    state: z.literal('rejected'),
    requestId: label,
    decidedAt: iso,
  }),
  z.strictObject({ state: z.literal('expired') }),
]);

const destinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('saved'),
    addressId: z.uuid(),
    version: iso,
  }),
  z.strictObject({
    kind: z.literal('new'),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
export type MinimalShippingDestination = z.infer<typeof destinationSchema>;

/** Fixed-order, lossless canonical content; never normalize away an address edit. */
export function minimalShippingDestination(
  address: MinimalCheckoutDraftAddress,
): MinimalShippingDestination {
  if (address.kind === 'saved') {
    return {
      kind: 'saved',
      addressId: address.snapshot.id,
      version: address.snapshot.version,
    };
  }
  const f = address.fields;
  return {
    kind: 'new',
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          f.street,
          f.exteriorNumber,
          f.interiorNumber,
          f.zipCode,
          f.neighborhood,
          f.municipality,
          f.city,
          f.state,
        ]),
      )
      .digest('hex'),
  };
}

const deliverableZones: ReadonlySet<string> = new Set([
  'FREE',
  'SURCHARGE',
  'CARRIER_ONLY',
]);
/** Mirrors the backend DTO so every accepted response re-parses from the slot. */
export const minimalShippingQuoteSchema = z
  .strictObject({
    quoteId: z.string().min(1).nullable(),
    expiresAt: iso,
    zoneStatus: z.enum([
      'FREE',
      'SURCHARGE',
      'CARRIER_ONLY',
      'PENDING',
      'DENIED',
    ]),
    option: z
      .strictObject({
        carrier: z.string().min(1),
        service: z.string().min(1),
        etaDays: money.nullable(),
      })
      .nullable(),
    costCents: money,
    creditCents: money,
    customerChargeCents: money,
    currency: z.literal('MXN'),
    eta: z
      .strictObject({
        days: money.nullable(),
        reason: z.literal('STOCK_PENDING').optional(),
      })
      .nullable(),
    destinationPin: destinationSchema,
    cartPin: cartLinesSchema,
  })
  .refine(
    (record) =>
      !deliverableZones.has(record.zoneStatus) || record.quoteId !== null,
  );
export type MinimalShippingQuote = z.infer<typeof minimalShippingQuoteSchema>;
export type MinimalShippingCartLine = z.infer<typeof cartLineSchema>;

/** Store the backend answer as returned; anything off-schema => null. */
export function buildMinimalShippingQuote(input: {
  response: ShippingQuoteResponse;
  cartLines: readonly MinimalShippingCartLine[];
  destination: MinimalShippingDestination;
}): MinimalShippingQuote | null {
  const r = input.response;
  const result = minimalShippingQuoteSchema.safeParse({
    quoteId: r.quoteId,
    expiresAt: r.expiresAt,
    zoneStatus: r.zoneStatus,
    option: r.option,
    costCents: r.costCents,
    creditCents: r.creditCents,
    customerChargeCents: r.customerChargeCents,
    currency: r.currency,
    eta: r.eta ?? null,
    destinationPin: input.destination,
    cartPin: input.cartLines,
  });
  return result.success ? structuredClone(result.data) : null;
}

/** New backend quote vs. a legacy approval record. */
export function isMinimalShippingQuote(
  record: MinimalShippingQuote | LegacyMinimalShipping,
): record is MinimalShippingQuote {
  return 'zoneStatus' in record;
}

/**
 * `current` only for a deliverable zone with a quoteId, strictly before the
 * backend `expiresAt`, whose cart and destination pins match exactly.
 */
export function isShippingCurrent(
  record: MinimalShippingQuote,
  context: {
    cartLines: readonly MinimalShippingCartLine[];
    address: MinimalCheckoutDraftAddress;
    nowMs: number;
  },
): 'current' | 'expired' | 'stale' | 'undeliverable' {
  if (!deliverableZones.has(record.zoneStatus) || record.quoteId === null)
    return 'undeliverable';
  if (
    !Number.isFinite(context.nowMs) ||
    context.nowMs >= Date.parse(record.expiresAt)
  )
    return 'expired';
  const current = minimalShippingDestination(context.address);
  const pin = record.destinationPin;
  const sameDestination =
    pin.kind === 'new'
      ? current.kind === 'new' && current.fingerprint === pin.fingerprint
      : current.kind === 'saved' &&
        current.addressId === pin.addressId &&
        current.version === pin.version;
  const lines = cartLinesSchema.safeParse(context.cartLines);
  if (
    !sameDestination ||
    !lines.success ||
    lines.data.length !== record.cartPin.length
  )
    return 'stale';
  return record.cartPin.every((line) =>
    lines.data.some(
      (other) =>
        line.productId === other.productId &&
        line.variantId === other.variantId &&
        line.quantity === other.quantity &&
        line.unitPriceCents === other.unitPriceCents &&
        line.finalPriceCents === other.finalPriceCents,
    ),
  )
    ? 'current'
    : 'stale';
}

// ---- LEGACY per-quote approval records (U5/U6 delete) ----

const shippingFields = z.strictObject({
  quoteId: label,
  rateId: label,
  carrierName: label,
  serviceName: label,
  estimatedDeliveryDays: money.nullable(),
  bestRateCents: money,
  totalCreditCents: money,
  customerPaysCents: money,
  cartLines: cartLinesSchema,
  createdAt: iso,
  expiresAt: iso,
  approval: approvalSchema,
});
/** Legacy approval record; never created by the minimal route any more. */
export const legacyMinimalShippingSchema = z
  .union([
    shippingFields.extend({ addressId: z.uuid(), addressVersion: iso }),
    shippingFields.extend({ destination: destinationSchema }),
  ])
  .refine((record) => {
    const credit = calculateShippingCredit({
      bestRateCents: record.bestRateCents,
      items: record.cartLines,
    });
    const created = Date.parse(record.createdAt);
    const expires = Date.parse(record.expiresAt);
    const decision =
      'decidedAt' in record.approval
        ? Date.parse(record.approval.decidedAt)
        : null;
    return (
      credit.kind === 'calculated' &&
      credit.totalCreditCents === record.totalCreditCents &&
      credit.customerPaysCents === record.customerPaysCents &&
      expires > created &&
      expires <= created + MINIMAL_SHIPPING_TTL_MS &&
      (decision === null || (decision >= created && decision < expires))
    );
  });
export type LegacyMinimalShipping = z.infer<typeof legacyMinimalShippingSchema>;

/** Build an unstarted draft; invalid/expired provider or credit => null. */
export function buildMinimalShipping(
  input: {
    quote: ShippingQuoteQuotedResult;
    cartLines: readonly MinimalShippingCartLine[];
    createdAt: string;
  } & (
    | { addressId: string; addressVersion: string }
    | { destination: MinimalShippingDestination }
  ),
): LegacyMinimalShipping | null {
  const quote = normalizeShippingQuoteQuotedResult(input.quote);
  if (!quote || !iso.safeParse(input.createdAt).success) return null;
  const best = quote.rates.reduce((a, b) =>
    b.priceCents < a.priceCents ? b : a,
  );
  const credit = calculateShippingCredit({
    bestRateCents: best.priceCents,
    items: input.cartLines,
  });
  if (credit.kind !== 'calculated') return null;
  const expiresMs = Math.min(
    Date.parse(input.createdAt) + MINIMAL_SHIPPING_TTL_MS,
    quote.expiresAt === null ? Infinity : Date.parse(quote.expiresAt),
    best.validUntil === null ? Infinity : Date.parse(best.validUntil),
  );
  if (!Number.isFinite(expiresMs)) return null;
  const result = legacyMinimalShippingSchema.safeParse({
    quoteId: quote.quoteId,
    rateId: best.rateId,
    carrierName: best.carrierName,
    serviceName: best.serviceName,
    estimatedDeliveryDays: best.estimatedDeliveryDays,
    bestRateCents: credit.bestRateCents,
    totalCreditCents: credit.totalCreditCents,
    customerPaysCents: credit.customerPaysCents,
    cartLines: input.cartLines,
    ...('destination' in input
      ? { destination: input.destination }
      : { addressId: input.addressId, addressVersion: input.addressVersion }),
    createdAt: input.createdAt,
    expiresAt: new Date(expiresMs).toISOString(),
    approval: { state: 'not_requested' },
  });
  return result.success ? result.data : null;
}

/** T4 starts approval explicitly; no handoff or side effect happens here. */
export function requestMinimalShippingApproval(
  record: LegacyMinimalShipping,
  input: { requestId: string; nowMs: number },
): LegacyMinimalShipping | null {
  if (
    record.approval.state !== 'not_requested' ||
    !label.safeParse(input.requestId).success ||
    !Number.isFinite(input.nowMs) ||
    input.nowMs < Date.parse(record.createdAt)
  )
    return null;
  const result = legacyMinimalShippingSchema.safeParse({
    ...record,
    approval:
      input.nowMs >= Date.parse(record.expiresAt)
        ? { state: 'expired' }
        : { state: 'pending', requestId: input.requestId },
  });
  return result.success ? result.data : null;
}

/** Only a matching pending request can decide; an unstarted quote can expire. */
export function transitionShippingApproval(
  record: LegacyMinimalShipping,
  decision: {
    state: 'approved' | 'rejected' | 'expired';
    requestId: string;
    nowMs: number;
  },
): LegacyMinimalShipping | null {
  if (record.approval.state === 'not_requested') {
    if (
      decision.state !== 'expired' ||
      !Number.isFinite(decision.nowMs) ||
      decision.nowMs < Date.parse(record.expiresAt)
    )
      return null;
    const result = legacyMinimalShippingSchema.safeParse({
      ...record,
      approval: { state: 'expired' },
    });
    return result.success ? result.data : null;
  }
  if (
    record.approval.state !== 'pending' ||
    decision.requestId !== record.approval.requestId ||
    !Number.isFinite(decision.nowMs) ||
    decision.nowMs < Date.parse(record.createdAt)
  )
    return null;
  const state =
    decision.nowMs >= Date.parse(record.expiresAt) ? 'expired' : decision.state;
  const result = legacyMinimalShippingSchema.safeParse({
    ...record,
    approval:
      state === 'expired'
        ? { state }
        : {
            state,
            requestId: decision.requestId,
            decidedAt: new Date(decision.nowMs).toISOString(),
          },
  });
  return result.success ? result.data : null;
}
