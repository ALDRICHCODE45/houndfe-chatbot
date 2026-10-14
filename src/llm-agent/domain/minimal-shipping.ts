/**
 * Pure minimal-route shipping, owned exclusively by `minimalCart.shipping`.
 * `quoteId`/`rateId` identify the cheapest provider rate (first wins ties);
 * `carrierName`, `serviceName`, `estimatedDeliveryDays` (null = unavailable)
 * are provider labels/ETA. All amounts are integer MXN cents.
 * `cartLines` bind identity, quantity, unit price and evaluated merchandise
 * line total (`finalPriceCents`); line ordering is not significant.
 * `destination` binds saved id/version or a SHA-256 of confirmed new-address
 * fields. Legacy top-level `addressId`/`addressVersion` records still parse.
 * `createdAt`/`expiresAt` are zoned ISO timestamps, capped at 30 minutes and
 * provider/rate validity. `approval.state` starts not_requested, then pending {requestId}, approved
 * or rejected {requestId, decidedAt}, or expired (no decision metadata).
 * Freshness is NOT approval: a current pending/rejected record cannot authorize
 * disclosure or sale. Callers must separately require approved (S1).
 * No clock, store, transport, framework or SDK dependency.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MinimalCheckoutDraftAddress } from '../../conversation/domain/minimal-checkout-draft';
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
/** Strict persisted record; legacy saved records remain parseable without rewriting. */
export const minimalShippingSchema = z
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
export type MinimalShipping = z.infer<typeof minimalShippingSchema>;
export type MinimalShippingCartLine = z.infer<typeof cartLineSchema>;

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
): MinimalShipping | null {
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
  const result = minimalShippingSchema.safeParse({
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

/** Classification only; free shipping still requires human approval. */
export function classifyMinimalShipping(
  record: MinimalShipping,
): 'free' | 'charged' {
  return record.customerPaysCents === 0 ? 'free' : 'charged';
}

export function isShippingCurrent(
  record: MinimalShipping,
  context: {
    cartLines: readonly MinimalShippingCartLine[];
    nowMs: number;
  } & (
    | { addressId: string; addressVersion: string }
    | { address: MinimalCheckoutDraftAddress }
  ),
): 'stale' | 'expired' | 'current' {
  if (
    record.approval.state === 'expired' ||
    context.nowMs >= Date.parse(record.expiresAt)
  )
    return 'expired';
  if (
    !Number.isFinite(context.nowMs) ||
    context.nowMs < Date.parse(record.createdAt)
  )
    return 'stale';
  const lines = cartLinesSchema.safeParse(context.cartLines);
  const expected =
    'destination' in record
      ? record.destination
      : {
          kind: 'saved' as const,
          addressId: record.addressId,
          version: record.addressVersion,
        };
  const current =
    'address' in context
      ? minimalShippingDestination(context.address)
      : {
          kind: 'saved' as const,
          addressId: context.addressId,
          version: context.addressVersion,
        };
  const sameDestination =
    expected.kind === 'new'
      ? current.kind === 'new' && current.fingerprint === expected.fingerprint
      : current.kind === 'saved' &&
        current.addressId === expected.addressId &&
        current.version === expected.version;
  if (
    !lines.success ||
    !sameDestination ||
    lines.data.length !== record.cartLines.length
  )
    return 'stale';
  return record.cartLines.every((line) =>
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

/** T4 starts approval explicitly; no handoff or side effect happens here. */
export function requestMinimalShippingApproval(
  record: MinimalShipping,
  input: { requestId: string; nowMs: number },
): MinimalShipping | null {
  if (
    record.approval.state !== 'not_requested' ||
    !label.safeParse(input.requestId).success ||
    !Number.isFinite(input.nowMs) ||
    input.nowMs < Date.parse(record.createdAt)
  )
    return null;
  const result = minimalShippingSchema.safeParse({
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
  record: MinimalShipping,
  decision: {
    state: 'approved' | 'rejected' | 'expired';
    requestId: string;
    nowMs: number;
  },
): MinimalShipping | null {
  if (record.approval.state === 'not_requested') {
    if (
      decision.state !== 'expired' ||
      !Number.isFinite(decision.nowMs) ||
      decision.nowMs < Date.parse(record.expiresAt)
    )
      return null;
    const result = minimalShippingSchema.safeParse({
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
  const result = minimalShippingSchema.safeParse({
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
