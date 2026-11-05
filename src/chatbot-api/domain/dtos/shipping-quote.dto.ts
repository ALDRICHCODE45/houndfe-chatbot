import { z } from 'zod';
import { isCheckoutUuid } from './checkout-context.dto';

/**
 * `POST /chatbot-api/shipping/quotes` contract (backend
 * `docs/shipping-and-delivery-zones-proposal.md` §9-11). The backend picks the
 * cheapest carrier and computes the credit; the bot only shows the result.
 * Field names live only in this file so a backend rename touches nothing else.
 */
export const PACKAGING_DATA_MISSING = 'PACKAGING_DATA_MISSING';
export const SHIPPING_QUOTE_UNAVAILABLE = 'SHIPPING_QUOTE_UNAVAILABLE';
/** Checkout rejections of `shipping: {quoteId}`: nothing was created. */
export const SHIPPING_QUOTE_NOT_FOUND = 'SHIPPING_QUOTE_NOT_FOUND';
export const SHIPPING_QUOTE_EXPIRED = 'SHIPPING_QUOTE_EXPIRED';
export const SHIPPING_QUOTE_MISMATCH = 'SHIPPING_QUOTE_MISMATCH';

const uuid = z.string().refine(isCheckoutUuid, 'Invalid UUID');
const cents = z.number().int().min(0).max(2147483647);
const instant = z.string().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, 'Invalid canonical instant');

const savedDestination = z.object({ shippingAddressId: uuid }).strict();
const rawDestination = z
  .object({
    street: z.string().min(1).max(200).optional(),
    exteriorNumber: z.string().max(20).optional(),
    interiorNumber: z.string().max(20).optional(),
    zipCode: z.string().min(1).max(10),
    neighborhood: z.string().min(1).max(100),
    municipality: z.string().min(1).max(100),
    state: z.string().min(1).max(100),
    city: z.string().max(100).optional(),
  })
  .strict();

/** Exactly one destination form: both strict members reject the other's keys. */
export const CreateShippingQuoteInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: uuid,
            variantId: uuid.nullish(),
            quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .min(1),
    phoneCountryCode: z.string().regex(/^[0-9]{1,10}$/),
    phone: z.string().regex(/^[0-9]{1,20}$/),
    destination: z.union([savedDestination, rawDestination]),
  })
  .strict();
export type CreateShippingQuoteInput = z.infer<
  typeof CreateShippingQuoteInputSchema
>;

const zoneStatus = z.enum([
  'FREE',
  'SURCHARGE',
  'CARRIER_ONLY',
  'PENDING',
  'DENIED',
]);
export type ShippingZoneStatus = z.infer<typeof zoneStatus>;

const shippingQuoteResponse = z
  .object({
    quoteId: z.string().min(1).nullable(),
    expiresAt: instant,
    zoneStatus,
    option: z
      .object({
        carrier: z.string().min(1),
        service: z.string().min(1),
        etaDays: z.number().int().min(0).nullable(),
      })
      .strict()
      .nullable(),
    costCents: cents,
    creditCents: cents,
    customerChargeCents: cents,
    currency: z.literal('MXN'),
    eta: z
      .object({
        days: z.number().int().min(0).nullable(),
        reason: z.literal('STOCK_PENDING').optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (quote) =>
      quote.zoneStatus === 'PENDING' ||
      quote.zoneStatus === 'DENIED' ||
      quote.quoteId !== null,
    { path: ['quoteId'], message: 'Deliverable zones require a quoteId' },
  );
export type ShippingQuoteResponse = z.infer<typeof shippingQuoteResponse>;

/** Strict parse; any unknown value or key yields `null` (fail closed). */
export function normalizeShippingQuoteResponse(
  body: unknown,
): ShippingQuoteResponse | null {
  const parsed = shippingQuoteResponse.safeParse(body);
  return parsed.success ? parsed.data : null;
}
