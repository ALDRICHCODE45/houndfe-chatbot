/**
 * SQ-5B2B1 strict Meta sender-identity boundary.
 *
 * Meta delivers a WhatsApp sender ID as a digit-only string carrying a country
 * prefix: the current shape `52` + ten national digits, or the legacy shape
 * `521` + ten digits (the retired national trunk `1`). The backend
 * `chatbot-api` expects the country code `52` and the bare ten-digit phone, so
 * this boundary normalizes both accepted shapes into one exact-key, deeply
 * frozen value.
 *
 * It never coerces, trims, pads, logs, or performs I/O: any other country,
 * prefix, length, encoding, or non-primitive input returns `null`. The ten
 * digits are kept exactly, including internal and repeated zeros, but a
 * leading zero is rejected as an ambiguous local value (Mexico-only demo
 * scope).
 */
export interface MexicanWhatsAppPhone {
  readonly phoneCountryCode: '52';
  readonly phone: string;
}

const MODERN_PREFIX = '52';
const LEGACY_PREFIX = '521';
const NATIONAL_PHONE_LENGTH = 10;

/** Ten characters, each an ASCII `0`-`9`; rejects Unicode/full-width digits. */
// prettier-ignore
function isNationalPhone(value: string): boolean { if (value.length !== NATIONAL_PHONE_LENGTH) return false; for (let index = 0; index < NATIONAL_PHONE_LENGTH; index += 1) { const code = value.charCodeAt(index); if (code < 48 || code > 57) return false; } return true; }

/**
 * Never-throwing primitive boundary. Accepts only a digit-only string of `52`
 * + ten digits or `521` + ten digits and returns a fresh, exact-key, deeply
 * frozen `{ phoneCountryCode: '52', phone }`; everything else is `null`. Reads
 * no property of a non-string input.
 */
// prettier-ignore
export function parseMexicanWhatsAppPhone(value: unknown): MexicanWhatsAppPhone | null {
  try {
    if (typeof value !== 'string') return null;
    let phone: string;
    if (value.length === MODERN_PREFIX.length + NATIONAL_PHONE_LENGTH) {
      if (!value.startsWith(MODERN_PREFIX)) return null;
      phone = value.slice(MODERN_PREFIX.length);
    } else if (value.length === LEGACY_PREFIX.length + NATIONAL_PHONE_LENGTH) {
      if (!value.startsWith(LEGACY_PREFIX)) return null;
      phone = value.slice(LEGACY_PREFIX.length);
    } else {
      return null;
    }
    if (!isNationalPhone(phone) || phone.charCodeAt(0) === 48) return null;
    return Object.freeze({ phoneCountryCode: MODERN_PREFIX, phone });
  } catch {
    return null;
  }
}
