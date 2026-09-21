/**
 * SQ-3C3 provider-neutral request -> Skydropx V1 wire mapper. Pure and
 * never-throwing. Every field, the parcel-array length, and each element are
 * snapshotted exactly once into fresh internal values before validation, so
 * stateful getters, sparse arrays, class instances, and hostile proxies fail
 * closed as `null` with no caller reference retained. Dimensions pass through
 * in centimeters and `weightGrams` divides by 1000 into kilograms; only the
 * official V1 addresses-plus-parcels shape is emitted.
 */
import {
  isShippingQuoteAddress,
  isShippingQuoteParcel,
  isShippingQuoteRequest,
  type ShippingQuoteAddress,
  type ShippingQuoteParcel,
  type ShippingQuoteRequest,
} from '../domain/shipping-quote.request';
import type {
  SkydropxQuotationAddress,
  SkydropxQuotationParcel,
  SkydropxQuotationPayload,
} from './skydropx-quotation.client';
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
/** Snapshot one address, reading each field once; a throwing getter fails. */
function snapshotAddress(value: unknown): ShippingQuoteAddress | null {
  if (!isPlainRecord(value)) return null;
  try {
    const candidate: unknown = {
      countryCode: value.countryCode,
      postalCode: value.postalCode,
      state: value.state,
      municipality: value.municipality,
      neighborhood: value.neighborhood,
    };
    return isShippingQuoteAddress(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
function snapshotParcel(value: unknown): ShippingQuoteParcel | null {
  if (!isPlainRecord(value)) return null;
  try {
    const candidate: unknown = {
      lengthCm: value.lengthCm,
      widthCm: value.widthCm,
      heightCm: value.heightCm,
      weightGrams: value.weightGrams,
    };
    return isShippingQuoteParcel(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
function snapshotParcels(
  value: unknown,
): readonly ShippingQuoteParcel[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const source = value as readonly unknown[];
    const rawLength: unknown = source.length;
    if (
      typeof rawLength !== 'number' ||
      !Number.isSafeInteger(rawLength) ||
      rawLength < 1
    ) {
      return null;
    }
    const length = rawLength;
    const out: ShippingQuoteParcel[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(source, index)) return null;
      const element: unknown = source[index];
      const parcel = snapshotParcel(element);
      if (parcel === null) return null;
      out.push(parcel);
    }
    return out;
  } catch {
    return null;
  }
}
function snapshotRequest(value: unknown): ShippingQuoteRequest | null {
  if (!isPlainRecord(value)) return null;
  try {
    const origin = snapshotAddress(value.origin);
    const destination = snapshotAddress(value.destination);
    const parcels = snapshotParcels(value.parcels);
    if (origin === null || destination === null || parcels === null) {
      return null;
    }
    const candidate: unknown = { origin, destination, parcels };
    return isShippingQuoteRequest(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
function toWireAddress(
  address: ShippingQuoteAddress,
): SkydropxQuotationAddress {
  return Object.freeze({
    country_code: address.countryCode,
    postal_code: address.postalCode,
    area_level1: address.state,
    area_level2: address.municipality,
    area_level3: address.neighborhood,
  });
}
function toWireParcel(parcel: ShippingQuoteParcel): SkydropxQuotationParcel {
  return Object.freeze({
    length: parcel.lengthCm,
    width: parcel.widthCm,
    height: parcel.heightCm,
    weight: parcel.weightGrams / 1000,
  });
}
export function mapSkydropxQuotationRequest(
  value: unknown,
): SkydropxQuotationPayload | null {
  try {
    const request = snapshotRequest(value);
    if (request === null) return null;
    return Object.freeze({
      quotation: Object.freeze({
        address_from: toWireAddress(request.origin),
        address_to: toWireAddress(request.destination),
        parcels: Object.freeze(request.parcels.map(toWireParcel)),
      }),
    });
  } catch {
    return null;
  }
}
