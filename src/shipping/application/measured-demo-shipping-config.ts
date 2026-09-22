/**
 * SQ-5B2A private measured-demo configuration membrane.
 *
 * Resolves one optional private raw profile JSON plus the exact Skydropx origin
 * from a minimal structural config source into a fresh, exact-key, deeply
 * frozen `{ profile, origin }`, or `null`. The membrane never throws, never
 * logs, and never retains raw JSON: it snapshots each of the five declared
 * paths once, guards `JSON.parse`, and normalizes the profile only through the
 * committed SQ-5B1 boundary. Boot is never fatal here; a missing or invalid
 * profile resolves to `null` so the future tool fails closed.
 */
import {
  normalizeMeasuredDemoParcelProfile,
  type MeasuredDemoParcelProfile,
} from './measured-demo-parcel-profile';

/** Unique DI token for the resolved private measured-demo shipping config. */
export const MEASURED_DEMO_SHIPPING_CONFIG = Symbol(
  'MEASURED_DEMO_SHIPPING_CONFIG',
);

/** Largest accepted raw profile string, in UTF-16 code units. */
export const MAX_MEASURED_DEMO_PROFILE_JSON_CODE_UNITS = 16_384;

// prettier-ignore
export interface MeasuredDemoShippingOrigin { readonly postalCode: string; readonly state: string; readonly municipality: string; readonly neighborhood: string; }
// prettier-ignore
export interface MeasuredDemoShippingConfig { readonly profile: MeasuredDemoParcelProfile; readonly origin: MeasuredDemoShippingOrigin; }
/** Minimal structural config source; `get` is a function-typed property boundary. */
export interface MeasuredDemoShippingConfigSource {
  get: (key: string) => unknown;
}

const PROFILE_JSON_KEY = 'shippingQuotes.measuredDemoParcelProfileJson';
const ORIGIN_KEYS = {
  postalCode: 'shippingQuotes.skydropx.originPostalCode',
  state: 'shippingQuotes.skydropx.originState',
  municipality: 'shippingQuotes.skydropx.originMunicipality',
  neighborhood: 'shippingQuotes.skydropx.originNeighborhood',
} as const;
const POSTAL_CODE_RE = /^[0-9]{5}$/;
const MAX_ORIGIN_TEXT_CODE_UNITS = 100;

// prettier-ignore
const boundedText = (value: unknown): string | null => { if (typeof value !== 'string') return null; const trimmed = value.trim(); return trimmed.length === 0 || trimmed.length > MAX_ORIGIN_TEXT_CODE_UNITS ? null : trimmed; };

// prettier-ignore
function normalizeProfile(raw: unknown): MeasuredDemoParcelProfile | null { if (typeof raw !== 'string' || raw.length > MAX_MEASURED_DEMO_PROFILE_JSON_CODE_UNITS) return null; const json = raw.trim(); if (json.length === 0) return null; try { return normalizeMeasuredDemoParcelProfile(JSON.parse(json)); } catch { return null; } }

// prettier-ignore
function normalizeOrigin(values: readonly unknown[]): MeasuredDemoShippingOrigin | null { const [postal, state, municipality, neighborhood] = values; if (typeof postal !== 'string') return null; const postalCode = postal.trim(); if (!POSTAL_CODE_RE.test(postalCode)) return null; const s = boundedText(state); const m = boundedText(municipality); const n = boundedText(neighborhood); if (s === null || m === null || n === null) return null; return Object.freeze({ postalCode, state: s, municipality: m, neighborhood: n }); }

/**
 * Never-throwing one-read resolver. Reads exactly the five declared paths once
 * each from the structural source and returns a fresh deeply frozen config or
 * `null` for any absent, malformed, oversized, or hostile input.
 */
// prettier-ignore
export function resolveMeasuredDemoShippingConfig(source: MeasuredDemoShippingConfigSource): MeasuredDemoShippingConfig | null {
  try {
    if (typeof source !== 'object' || source === null) return null;
    const get = source.get.bind(source);
    if (typeof get !== 'function') return null;
    const rawProfile = get(PROFILE_JSON_KEY);
    const rawOrigin = [get(ORIGIN_KEYS.postalCode), get(ORIGIN_KEYS.state), get(ORIGIN_KEYS.municipality), get(ORIGIN_KEYS.neighborhood)];
    const profile = normalizeProfile(rawProfile);
    if (profile === null) return null;
    const origin = normalizeOrigin(rawOrigin);
    if (origin === null) return null;
    return Object.freeze({ profile, origin });
  } catch { return null; }
}
