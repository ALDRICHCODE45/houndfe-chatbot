import { normalizeExpirationDecision } from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import {
  applyCustomerStyle,
  type CustomerStyle,
} from '../../customer-profile/domain/notice-style';

export type ExpirationReplyPreparation =
  | Readonly<{ action: 'prepared'; text: string }>
  | Readonly<{ action: 'hold' }>;
const HOLD: ExpirationReplyPreparation = Object.freeze({ action: 'hold' });
const MAX_TEXT_LENGTH = 4096;
const UNAVAILABLE_QUESTION =
  '¿Desea continuar con la compra o prefiere que le ayude con alguna otra consulta?';
const styled = (text: string, style?: CustomerStyle | null): string =>
  style === undefined || style === null
    ? text
    : applyCustomerStyle(text, style);

/** Preserve historical label bytes; reject unusable labels instead of editing. */
function displayableLabel(value: string | null): value is string {
  if (value === null || !value.trim() || value.length > MAX_TEXT_LENGTH)
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

/** Pure, inactive copy preparation from the original backend JSON projection.
 * Reuse its normalizer; never interpret human text, infer dates or use browsing.
 * Only displayed historical labels are checked here; unit/option/value are not
 * inferred as a presentation. No I/O, LLM, clock, store or send integration.
 * `prepared` is text ONLY, not provenance, binding or delivery authority. The
 * caller still owes the original trusted request/decision, fresh resolution and
 * WhatsApp eligibility checks before any later send. Oversize copy holds intact.
 */
export function prepareExpirationReply(
  projection: unknown,
  // S1: the stored customer style for the FIXED copy only; the human answer
  // and product labels are never rewritten. Absent → the usted copy.
  style?: CustomerStyle | null,
): ExpirationReplyPreparation {
  const decision = normalizeExpirationDecision(projection);
  if (decision?.status !== 'RESOLVED') return HOLD;
  const { productName, variantId, variantName } = decision.snapshot;
  if (!displayableLabel(productName)) return HOLD;
  if (variantId !== null && !displayableLabel(variantName)) return HOLD;
  const subject =
    variantId === null
      ? productName
      : `${productName} (presentación: ${variantName})`;
  const text =
    decision.resolution.action === 'PROVIDE_EXPIRATION_TEXT'
      ? `Sobre la caducidad de ${subject}:\nEl equipo de HoundFe indicó:\n${decision.resolution.expirationText}`
      : `Sobre el ${subject}, el equipo no pudo confirmar la fecha de caducidad. ${styled(UNAVAILABLE_QUESTION, style)}`;
  return text.length <= MAX_TEXT_LENGTH
    ? Object.freeze({ action: 'prepared', text })
    : HOLD;
}
