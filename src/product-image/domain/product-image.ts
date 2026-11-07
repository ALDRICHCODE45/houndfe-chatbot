/** S5 product image recognition: what a customer photo shows, and the pure
 * rules that turn that description into the customer's agent turn. The
 * image bytes never reach history; only the caption plus a compact,
 * sanitized description does. */

/** DI token for the vision describer. */
export const PRODUCT_IMAGE_DESCRIBER = Symbol('PRODUCT_IMAGE_DESCRIBER');

export type ProductImageMimeType = 'image/jpeg' | 'image/png';

export interface ProductImageDescriberInput {
  bytes: Buffer;
  mimeType: ProductImageMimeType;
}

export type ProductImageKind = 'product' | 'receipt' | 'other' | 'unclear';
export type ProductImageConfidence = 'high' | 'medium' | 'low';

export interface ProductImageDescription {
  kind: ProductImageKind;
  brand: string | null;
  productName: string | null;
  /** e.g. croquetas, arena, juguete. */
  productType: string | null;
  /** perro, gato, … */
  species: string | null;
  /** e.g. 18 kg. */
  size: string | null;
  flavorOrVariant: string | null;
  /** Short visible label text. */
  labelText: string | null;
  /** 1-3 short catalog queries, most specific first. */
  searchQueries: string[];
  confidence: ProductImageConfidence;
}

export type ProductImageRecognition =
  | ProductImageDescription
  | { kind: 'unavailable'; reason: 'timeout' | 'error' | 'unsupported' };

/** Describes a customer photo. Implementations never throw; failures
 * surface as `{ kind: 'unavailable' }`. */
export interface ProductImageDescriberPort {
  describe(input: ProductImageDescriberInput): Promise<ProductImageRecognition>;
}

/** Customer replies (usted, short) for photos the agent cannot act on; the
 * dispatcher applies the customer style (S2) before sending. */
export const PRODUCT_IMAGE_UNCLEAR_REPLY =
  'No alcanzo a identificar el producto en la imagen. ¿Me puede enviar una foto más clara de la etiqueta o decirme el nombre del producto?';
export const PRODUCT_IMAGE_UNAVAILABLE_REPLY =
  'Recibí su imagen, pero no pude revisarla en este momento. ¿Me puede decir el nombre del producto que busca?';
export const RECEIPT_IMAGE_WITHOUT_ORDER_REPLY =
  'Recibí su imagen, parece un comprobante de pago. Para registrarlo primero necesitamos confirmar su pedido. ¿Qué producto desea?';

const DEFAULT_PRODUCT_QUESTION = '¿Tienen este producto?';
const MAX_QUERIES = 3;
const MAX_QUERY_LENGTH = 60;
const MAX_FIELD_LENGTH = 80;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/** Payment words win: "ya transferí, ¿cuánto falta?" is about a receipt. */
const PAYMENT_WORDS =
  /\b(pago|pague|pagado|comprobante|transferi\w*|transferencia|deposit\w*|spei|ticket|recibo)\b/;
const PRODUCT_QUESTION_WORDS =
  /\b(tiene[ns]?|hay|maneja[ns]?|vende[ns]?|cuesta[ns]?|cuanto|precio|disponible|producto|busco|buscando|interesa)\b/;

/** True when the caption reads as a question about the pictured product. */
export function looksLikeProductQuestion(caption: string | undefined): boolean {
  if (caption === undefined) return false;
  const text = normalize(caption);
  if (PAYMENT_WORDS.test(text)) return false;
  return PRODUCT_QUESTION_WORDS.test(text);
}

/** A product photo the agent can search for: anything but a low-confidence
 * guess with neither brand nor product name. */
export function isIdentifiableProduct(
  description: ProductImageDescription,
): boolean {
  if (description.kind !== 'product') return false;
  return (
    description.confidence !== 'low' ||
    description.brand !== null ||
    description.productName !== null
  );
}

/** Model text goes inside a bracketed block: drop anything that could close
 * it, quote-break the query list, or start a new line. */
function clean(value: string | null, max = MAX_FIELD_LENGTH): string | null {
  if (value === null) return null;
  const text = value
    .replace(/[[\]{}"<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return text.length > 0 ? text : null;
}

function describeFields(d: ProductImageDescription): string {
  const type = clean(d.productType);
  const species = clean(d.species);
  const name = clean(d.productName);
  const brand = clean(d.brand);
  const size = clean(d.size);
  const flavor = clean(d.flavorOrVariant);
  const label = clean(d.labelText);
  const parts = [
    type && species ? `${type} para ${species}` : (type ?? species),
    name && `producto "${name}"`,
    brand && `marca ${brand}`,
    size,
    flavor && `sabor/variante ${flavor}`,
    label && `texto visible: "${label}"`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? parts.join(', ') : 'producto sin identificar';
}

function searchQueries(d: ProductImageDescription): string[] {
  const given = d.searchQueries
    .map((query) => clean(query, MAX_QUERY_LENGTH))
    .filter((query): query is string => query !== null);
  if (given.length > 0) return given.slice(0, MAX_QUERIES);
  const join = (...parts: Array<string | null>) =>
    clean(parts.filter((part) => part !== null).join(' '), MAX_QUERY_LENGTH);
  const derived = [
    join(d.productName ?? d.brand, d.size),
    join(d.productType, d.brand),
    join(d.productType, d.species),
  ].filter((query): query is string => query !== null);
  return [...new Set(derived)].slice(0, MAX_QUERIES);
}

/** The synthetic customer turn for a recognized product photo: the caption
 * (or a default question) plus the compact description and the no-match
 * guidance the agent follows with real catalog data. */
export function buildProductImageTurnText(
  caption: string | undefined,
  description: ProductImageDescription,
): string {
  const question = caption?.trim() || DEFAULT_PRODUCT_QUESTION;
  const queries = searchQueries(description);
  const suggested =
    queries.length > 0
      ? ` Búsquedas sugeridas: ${queries.map((q) => `"${q}"`).join('; ')}.`
      : '';
  return (
    `${question}\n` +
    `[Imagen enviada por el cliente: ${describeFields(description)}.${suggested} ` +
    'Si no hay coincidencia exacta, ofrezca productos similares reales del catálogo (misma marca, mismo tipo o tamaño parecido) y aclare que no es el mismo; ' +
    'si la imagen no permite identificarlo, pida una foto de la etiqueta o el nombre.]'
  );
}
