import { normalizeExpirationDecision } from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';

export type ExpirationReplyPreparation =
  | Readonly<{ action: 'prepared'; text: string }>
  | Readonly<{ action: 'hold' }>;
const HOLD: ExpirationReplyPreparation = Object.freeze({ action: 'hold' });
const MAX_TEXT_LENGTH = 4096;

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
      : `Sobre el ${subject}, el equipo no pudo confirmar la fecha de caducidad. ¿Desea continuar con la compra o prefiere que le ayude con alguna otra consulta?`;
  return text.length <= MAX_TEXT_LENGTH
    ? Object.freeze({ action: 'prepared', text })
    : HOLD;
}
