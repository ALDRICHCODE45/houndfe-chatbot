/** SQ-5E4 E4-1c: fail-closed pinned-verdict match after one injected lookup. */
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ShippingQuoteDraftDestination } from '../../shipping/application/shipping-quote-draft-context';
import { isShippingQuoteAddress } from '../../shipping/domain/shipping-quote.request';
import { parseMexicanWhatsAppPhone } from '../domain/mexican-whatsapp-phone';
import type { ShippingSaleChargedVerdict } from './shipping-sale-revalidation';

export type ShippingSalePinnedDestination = Pick<
  ShippingSaleChargedVerdict,
  'customerId' | 'shippingAddressId' | 'destination'
>;

export type ShippingSaleDestinationReason =
  | 'unsupported_sender'
  | 'customer_lookup_failure'
  | 'address_unavailable'
  | 'identity_mismatch'
  | 'destination_mismatch';

export type ShippingSaleDestinationResult =
  | { readonly kind: 'match' }
  | {
      readonly kind: 'blocked';
      readonly reason: ShippingSaleDestinationReason;
    };

const MATCH: ShippingSaleDestinationResult = Object.freeze({ kind: 'match' });
const blocked = (
  reason: ShippingSaleDestinationReason,
): ShippingSaleDestinationResult => Object.freeze({ kind: 'blocked', reason });

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i;
const MX_ZIP = /^[0-9]{5}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

const canonicalUuid = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

interface CurrentDestination {
  readonly customerId: string;
  readonly shippingAddressId: string;
  readonly destination: ShippingQuoteDraftDestination;
}

function readCanonicalDestination(
  customerIdRaw: unknown,
  addressIdRaw: unknown,
  address: unknown,
): CurrentDestination | null {
  try {
    const customerId = canonicalUuid(customerIdRaw);
    const shippingAddressId = canonicalUuid(addressIdRaw);
    if (customerId === null || shippingAddressId === null) return null;
    if (!isPlainRecord(address)) return null;
    const { zipCode, state, municipality, neighborhood } = address;
    if (
      typeof zipCode !== 'string' ||
      !MX_ZIP.test(zipCode) ||
      typeof state !== 'string' ||
      typeof municipality !== 'string' ||
      typeof neighborhood !== 'string'
    ) {
      return null;
    }
    const bounded = Object.freeze({
      countryCode: 'MX',
      postalCode: zipCode,
      state,
      municipality,
      neighborhood,
    });
    if (!isShippingQuoteAddress(bounded)) return null;
    return Object.freeze({
      customerId,
      shippingAddressId,
      destination: Object.freeze({
        zipCode,
        state,
        municipality,
        neighborhood,
      }),
    });
  } catch {
    return null;
  }
}

function readLookupDestination(lookup: unknown): CurrentDestination | null {
  if (!isPlainRecord(lookup)) return null;
  try {
    if (lookup.found !== true) return null;
    const customer: unknown = lookup.customer;
    if (!isPlainRecord(customer)) return null;
    const address: unknown = customer.address;
    if (!isPlainRecord(address)) return null;
    return readCanonicalDestination(customer.customerId, address.id, address);
  } catch {
    return null;
  }
}

function readPinnedDestination(pinned: unknown): CurrentDestination | null {
  if (!isPlainRecord(pinned)) return null;
  try {
    return readCanonicalDestination(
      pinned.customerId,
      pinned.shippingAddressId,
      pinned.destination,
    );
  } catch {
    return null;
  }
}

const destinationEquals = (
  a: ShippingQuoteDraftDestination,
  b: ShippingQuoteDraftDestination,
): boolean =>
  a.zipCode === b.zipCode &&
  a.state === b.state &&
  a.municipality === b.municipality &&
  a.neighborhood === b.neighborhood;

export async function resolveShippingSaleDestination(
  senderId: unknown,
  pinned: ShippingSalePinnedDestination,
  api: Pick<ChatbotApiClient, 'getCustomerByPhone'>,
): Promise<ShippingSaleDestinationResult> {
  const phone = parseMexicanWhatsAppPhone(senderId);
  if (phone === null) return blocked('unsupported_sender');
  const target = readPinnedDestination(pinned);
  if (target === null) return blocked('address_unavailable');

  let lookup: unknown;
  try {
    lookup = await api.getCustomerByPhone(phone.phoneCountryCode, phone.phone);
  } catch {
    return blocked('customer_lookup_failure');
  }

  const current = readLookupDestination(lookup);
  if (current === null) return blocked('address_unavailable');
  if (
    current.customerId !== target.customerId ||
    current.shippingAddressId !== target.shippingAddressId
  ) {
    return blocked('identity_mismatch');
  }
  if (!destinationEquals(current.destination, target.destination)) {
    return blocked('destination_mismatch');
  }
  return MATCH;
}
