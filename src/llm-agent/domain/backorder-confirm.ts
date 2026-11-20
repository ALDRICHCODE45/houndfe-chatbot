import { classifyConfirmationReply } from './confirmation-reply';

/**
 * Restock backorder T5b (S6): the typed words that confirm a RESERVED
 * backorder. Whole message only, from a closed lexicon: the shared bare yes
 * (`classifyConfirmationReply`: «sí», «ok», «dale», «confirmo»…) plus the few
 * phrases that name the wish itself («sí lo quiero», «lo confirmo»). Anything
 * carrying a correction, a condition, a question or other content is not a
 * confirmation and stays with the other flows.
 */
const EXTRA = new Set([
  'lo quiero',
  'si lo quiero',
  'si lo quiero por favor',
  'lo confirmo',
  'si lo confirmo',
  'confirmo mi pedido',
  'si confirmo mi pedido',
  'confirmo mi pedido apartado',
  'quiero confirmar',
  'quiero confirmar mi pedido',
]);

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** True when the whole message is a confirmation of the reserved backorder. */
export function isBackorderConfirmText(text: unknown): boolean {
  if (typeof text !== 'string' || text.length > 60) return false;
  return classifyConfirmationReply(text) === 'accept' || EXTRA.has(fold(text));
}
