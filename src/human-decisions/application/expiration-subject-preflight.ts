/**
 * EXPIRATION subject grounding preflight — PURE, synchronous, unregistered.
 * Grounds ONLY the source and an explicit owned catalog subject from a real,
 * same-sender `CatalogSession`; writes/reserves/sends/reads nothing. `grounded`
 * is not selection, reservation, registration, notification, or stock proof.
 * The session owns freshness/history; non-authentic sessions and bad refs block.
 */
import { CatalogSession } from '../../conversation/domain/catalog-references';
import type { ExpirationIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import { bindExpirationInboundEvent } from '../domain/expiration-source-identity';

export interface ExpirationSubjectPreflightInput {
  readonly senderId: string;
  readonly catalogSession?: CatalogSession;
  readonly inboundEvent: unknown;
  readonly candidate: unknown;
}

export type ExpirationBlockReason =
  | 'identity_unbound'
  | 'catalog_unverified'
  | 'invalid_candidate'
  | 'unknown_product'
  | 'foreign_variant';

export type ExpirationSubjectPreflightOutcome =
  | { readonly status: 'grounded'; readonly intake: ExpirationIntakeInput }
  | { readonly status: 'clarification'; readonly reason: 'variant_required' }
  | { readonly status: 'blocked'; readonly reason: ExpirationBlockReason };

interface Candidate {
  readonly productId: string;
  /** `undefined` = not stated (ambiguity); `null` = explicit "no variant". */
  readonly variantId: string | null | undefined;
}

/** The same strict RFC4122 pattern the EXPIRATION intake wire uses. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = ['productId', 'variantId'];

const blocked = (reason: ExpirationBlockReason) =>
  ({ status: 'blocked', reason }) as const;

/** Brand-only checks are spoofable: require the exact base prototype, unshadowed. */
function isAuthenticSession(value: unknown): value is CatalogSession {
  if (!CatalogSession.is(value)) return false;
  if (Object.getPrototypeOf(value) !== CatalogSession.prototype) return false;
  return Reflect.ownKeys(CatalogSession.prototype).every(
    (key) =>
      key === 'constructor' ||
      !Object.prototype.hasOwnProperty.call(value, key),
  );
}

/** Snapshot the candidate once; any extra key (a model label) is never read. */
function parseCandidate(value: unknown): Candidate | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const proto = Reflect.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const snap = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return null;
      if (!KEYS.includes(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return null;
      const read = (value as Record<string, unknown>)[key];
      if (!Object.is(descriptor.value, read)) return null;
      snap[key] = descriptor.value;
    }
    const { productId, variantId } = snap;
    if (typeof productId !== 'string' || !UUID.test(productId)) return null;
    if (!('variantId' in snap) || variantId === undefined) {
      return { productId, variantId: undefined };
    }
    if (variantId === null) return { productId, variantId: null };
    if (typeof variantId !== 'string' || !UUID.test(variantId)) return null;
    return { productId, variantId };
  } catch {
    return null;
  }
}

export function preflightExpirationSubject(
  input: ExpirationSubjectPreflightInput,
): ExpirationSubjectPreflightOutcome {
  let senderId: string;
  let bound: ReturnType<typeof bindExpirationInboundEvent>;
  try {
    senderId = input.senderId;
    bound = bindExpirationInboundEvent(input.inboundEvent, senderId);
  } catch {
    return blocked('identity_unbound');
  }
  if (bound === null) return blocked('identity_unbound');

  try {
    const candidate = parseCandidate(input.candidate);
    if (candidate === null) return blocked('invalid_candidate');
    const session: unknown = input.catalogSession;
    if (!isAuthenticSession(session)) return blocked('catalog_unverified');
    if (session.senderId !== senderId) return blocked('catalog_unverified');
    const snapshot = CatalogSession.prototype.snapshot.call(session);
    if (snapshot === null) return blocked('catalog_unverified');
    const product = snapshot.products.find(
      (entry) => entry.productId === candidate.productId,
    );
    if (product === undefined) return blocked('unknown_product');

    let variantId: string | null;
    if (candidate.variantId === undefined) {
      return { status: 'clarification', reason: 'variant_required' };
    } else if (candidate.variantId === null) {
      if (product.variants.length > 0) {
        return { status: 'clarification', reason: 'variant_required' };
      }
      variantId = null;
    } else {
      const variant = product.variants.find(
        (entry) => entry.variantId === candidate.variantId,
      );
      if (variant === undefined) return blocked('foreign_variant');
      variantId = variant.variantId;
    }

    const resolved = CatalogSession.prototype.resolve.call(session, {
      productId: product.productId,
      variantId,
    });
    if (resolved === null) return blocked('catalog_unverified');
    return {
      status: 'grounded',
      intake: {
        sourceRequestId: bound.sourceRequestId,
        type: 'EXPIRATION',
        productId: resolved.productId,
        variantId: resolved.variantId,
      },
    };
  } catch {
    return blocked('catalog_unverified');
  }
}
