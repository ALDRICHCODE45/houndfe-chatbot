import { z } from 'zod';
import { isCheckoutUuid } from './checkout-context.dto';

/**
 * `POST /chatbot-api/shipping/quotes` contract (docs/contracts/shipping-quotes.md,
 * scope `shipping:quote`). The backend picks the cheapest carrier and computes
 * the credit; the bot only shows the result. Field names live only in this
 * file so a backend rename touches nothing else.
 */
/** Quote rejections (`body.error`); nothing is stored by the backend. */
export const INVALID_SHIPPING_DESTINATION = 'INVALID_SHIPPING_DESTINATION';
export const DUPLICATE_CART_LINE = 'DUPLICATE_CART_LINE';
export const PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND';
export const VARIANT_NOT_FOUND = 'VARIANT_NOT_FOUND';
export const SHIPPING_ADDRESS_NOT_FOUND = 'SHIPPING_ADDRESS_NOT_FOUND';
export const CUSTOMER_PHONE_AMBIGUOUS = 'CUSTOMER_PHONE_AMBIGUOUS';
export const PRICE_OUT_OF_DATE = 'PRICE_OUT_OF_DATE';
export const SHIPPING_ADDRESS_INCOMPLETE = 'SHIPPING_ADDRESS_INCOMPLETE';
export const PACKAGING_DATA_MISSING = 'PACKAGING_DATA_MISSING';
export const NO_SHIPPING_BOX_FITS = 'NO_SHIPPING_BOX_FITS';
export const SHIPPING_ORIGIN_NOT_CONFIGURED = 'SHIPPING_ORIGIN_NOT_CONFIGURED';
/** 503, also while CARRIER_ONLY has no carrier adapter. */
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
/** Exactly the four zone fields; street and numbers never leave the bot. */
const rawDestination = z
  .object({
    zipCode: z.string().min(1).max(10),
    state: z.string().min(1).max(100),
    municipality: z.string().min(1).max(100),
    neighborhood: z.string().min(1).max(100),
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

export type ShippingZoneStatus =
  | 'FREE'
  | 'SURCHARGE'
  | 'CARRIER_ONLY'
  | 'PENDING'
  | 'DENIED';

const option = z
  .object({
    carrier: z.string().min(1),
    service: z.string().min(1),
    etaDays: z.number().int().min(0).nullable(),
  })
  .strict();
const eta = z
  .object({
    days: z.number().int().min(0).nullable(),
    reason: z.literal('STOCK_PENDING').nullable(),
  })
  .strict();
const amounts = {
  costCents: cents,
  creditCents: cents,
  customerChargeCents: cents,
  currency: z.literal('MXN'),
  eta,
};
const deliverable = z
  .object({
    quoteId: z.string().min(1),
    expiresAt: instant,
    ...amounts,
  })
  .strict();
const zero = z.literal(0);

/**
 * FREE and SURCHARGE carry no carrier option; CARRIER_ONLY does. DENIED and
 * PENDING are not stored by the backend: null quoteId and expiresAt, zero
 * amounts.
 */
const shippingQuoteResponse = z.discriminatedUnion('zoneStatus', [
  deliverable.extend({
    zoneStatus: z.enum(['FREE', 'SURCHARGE']),
    option: z.null(),
  }),
  deliverable.extend({ zoneStatus: z.literal('CARRIER_ONLY'), option }),
  z
    .object({
      quoteId: z.null(),
      expiresAt: z.null(),
      zoneStatus: z.enum(['PENDING', 'DENIED']),
      option: option.nullable(),
      ...amounts,
      costCents: zero,
      creditCents: zero,
      customerChargeCents: zero,
    })
    .strict(),
]);
export type ShippingQuoteResponse = z.infer<typeof shippingQuoteResponse>;

/** Strict parse; any unknown value or key yields `null` (fail closed). */
export function normalizeShippingQuoteResponse(
  body: unknown,
): ShippingQuoteResponse | null {
  const parsed = shippingQuoteResponse.safeParse(body);
  return parsed.success ? parsed.data : null;
}
