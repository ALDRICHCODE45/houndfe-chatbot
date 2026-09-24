/**
 * SCA-1b: pure, deterministic Spanish customer disclosure renderer and strict
 * raw-text decision parser for the measured-product shipping pilot. Rendering
 * normalizes through the committed SCA-1a1 offer contract and only exposes the
 * disclosed merchandise/freight/total; parsing accepts exactly a whole `SI`/
 * `SÍ`/`NO` with outer spacing and an optional trailing period. Pure and finite:
 * unknown or hostile input fails closed with `null`, never throws, and there is
 * no store, router, provider, model, prompt, gate or backend access.
 */
import { normalizeShippingCustomerOffer } from './shipping-customer-acceptance';

export type ShippingCustomerDecision = 'accept' | 'decline';

const MXN_GROUP = /\B(?=(\d{3})+(?!\d))/g;
const DECISION = /^(?:si|sí|no)\.?$/i;
const OUTER_SPACING = /^[ \t]+|[ \t]+$/g;
const NEWLINES = /[\r\n]/;
const INT32_MAX_CENTS = 2_147_483_647;

/** Format nonnegative integer cents as `$#,###.## MXN` without locale APIs. */
function formatMxnCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const decimals = cents % 100;
  const grouped = String(whole).replace(MXN_GROUP, ',');
  return `$${grouped}.${String(decimals).padStart(2, '0')} MXN`;
}

/** Same fail-closed amount contract as the committed SCA-1a1 offer. */
function normalizeAmounts(
  merchandise: unknown,
  charge: unknown,
  total: unknown,
): readonly [number, number, number] | null {
  const isCents = (value: unknown, min: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
  if (!isCents(merchandise, 0) || !isCents(charge, 1) || !isCents(total, 1)) {
    return null;
  }
  if (total !== merchandise + charge || total > INT32_MAX_CENTS) return null;
  return [merchandise, charge, total];
}

/**
 * Deterministic disclosure for amounts already owned by a server-side caller.
 * Exposed so a pre-send preparation can render the price WITHOUT inventing a
 * provider message id or normalizing a fabricated marker; malformed values
 * fail closed.
 */
export function renderShippingCustomerAmounts(
  merchandiseCents: unknown,
  chargeCents: unknown,
  expectedTotalCents: unknown,
): string | null {
  try {
    const amounts = normalizeAmounts(
      merchandiseCents,
      chargeCents,
      expectedTotalCents,
    );
    if (amounts === null) return null;
    return [
      'Detalle de tu envío (producto medido):',
      `Mercancía: ${formatMxnCents(amounts[0])}`,
      `Envío: ${formatMxnCents(amounts[1])}`,
      `Total: ${formatMxnCents(amounts[2])}`,
      '',
      'Verificaremos el precio antes de registrar tu pedido. Si cambia, te mostraremos el nuevo total para que lo confirmes otra vez.',
      '',
      'Responde exactamente "SÍ" para aceptar o "NO" para rechazar.',
    ].join('\n');
  } catch {
    return null;
  }
}

/**
 * Disclosure text for a structurally valid offer, or `null` for an invalid or
 * malformed offer. This pure renderer has no clock, so an offer expired
 * relative to the present is not rejected here: the runtime expiry check is
 * deferred to the dispatcher. Only the server-disclosed amounts are rendered;
 * no customer phone, address or provider identifier is included, and no order
 * is claimed.
 */
export function renderShippingCustomerOffer(rawOffer: unknown): string | null {
  try {
    const offer = normalizeShippingCustomerOffer(rawOffer);
    if (offer === null) return null;
    return renderShippingCustomerAmounts(
      offer.merchandiseCents,
      offer.chargeCents,
      offer.expectedTotalCents,
    );
  } catch {
    return null;
  }
}

/**
 * Strictly parse a whole affirmative (`SI`/`SÍ`) or rejection (`NO`) message,
 * allowing case, outer spaces/tabs and one optional trailing period. Anything
 * else, including concatenated text, emoji, amounts, newlines or hostile
 * input, yields `null`. No NLP or model inference.
 */
export function parseShippingCustomerDecision(
  raw: unknown,
): ShippingCustomerDecision | null {
  try {
    if (typeof raw !== 'string' || NEWLINES.test(raw)) return null;
    const candidate = raw.replace(OUTER_SPACING, '');
    if (!DECISION.test(candidate)) return null;
    return candidate.charAt(0).toLowerCase() === 'n' ? 'decline' : 'accept';
  } catch {
    return null;
  }
}
