import {
  NEGATION_TOKENS,
  REMOVAL_VERBS,
  tokenize,
} from './minimal-cart-quantity';

const KEEP_VERBS = new Set([
  'deja',
  'dejame',
  'dejar',
  'deje',
  'contenga',
  'tenga',
  'manten',
  'conserva',
  'conservar',
]);
const COUNT_WORD =
  /^(?:cero|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)$/;

/** Current-turn authorization only; identities and atomic persistence belong to the service. */
export function hasKeepOnlyCartEvidence(text: string): boolean {
  const tokens = tokenize(text);
  // Unlike quantity grounding, even presentation digits fail closed here.
  if (tokens.some((token) => /\d/.test(token) || COUNT_WORD.test(token)))
    return false;
  const words = tokens.join(' ');
  if (/\botra unidad\b/.test(words)) return false;
  // Same fail-closed negation semantics as whole-line removal: any preceding negation.
  const affirmed = (index: number) =>
    index >= 0 &&
    !tokens.slice(0, index).some((token) => NEGATION_TOKENS.has(token));
  if (
    affirmed(tokens.findIndex((token) => REMOVAL_VERBS.has(token))) &&
    /\b(?:lo demas|los demas|las demas|el resto|lo otro)\b/.test(words)
  )
    return true;
  if (!/\b(?:solo|solamente|unicamente|nada mas)\b/.test(words)) return false;
  return (
    affirmed(tokens.findIndex((token) => KEEP_VERBS.has(token))) ||
    (tokens.includes('carrito') && affirmed(tokens.indexOf('quiero')))
  );
}
