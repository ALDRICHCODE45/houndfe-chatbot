/**
 * HD-R3b3 inert RESTOCK request preflight — a READ-ONLY recommendation for the
 * tool's future `kind: 'out_of_stock'` route. It writes nothing, reserves
 * nothing, sends nothing, and calls no LLM/POST/DI.
 *
 * ADVISORY ONLY. The final `RestockIntakeService` reserve CAS is still required
 * and still decides; this proves no exclusivity against a pre-R3b3 legacy
 * writer, and the conversation `pending` marker (W2) stays open. The chain is:
 * default-off -> exact legacy; enabled -> bind the CURRENT CUSTOMER TURN event
 * to the trusted sender (never a model/UUID), read the durable markers and the
 * conversation marker where UNKNOWN WINS, run the pure route policy, and only a
 * pure `restock` builds the ten-key intake. Anything else blocks — there is NO
 * legacy fallback once the feature is on and identity/markers are uncertain.
 *
 * An enabled path re-reads the catalog (`getStock`) from the trusted client
 * AFTER the marker reads: the `checkStock` signal that grounded the escalation
 * is not authority for a later POST. The intake uses BACKEND values only (the
 * model name and any model-supplied `sourceRequestId` are ignored) and always
 * sends `requestedQuantity: null`. TIME-OF-CHECK RACE: this fresh GET is NOT
 * atomic with the later reserve/POST, so a shortage can reappear between them;
 * the backend must enforce strict shortage-at-POST if that is required.
 *
 * Reasons are fixed codes only; no PII, digest text, or ids are returned.
 */
import { z } from 'zod';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  normalizeRestockIntake,
  type RestockIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type {
  ConversationState,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import { classifyRestockConversationLegacyMarker } from '../domain/restock-conversation-marker';
import {
  selectOutOfStockRoute,
  type OutOfStockRouteDecision,
} from '../domain/restock-route-policy';
import { bindRestockInboundEvent } from '../domain/restock-source-identity';
import type {
  SharedRouteMarkerState,
  SharedRouteMarkersPort,
} from '../domain/shared-route-markers';

export interface RestockPreflightInput {
  readonly senderId: string;
  /** The triggering customer-turn event; the only legal identity source. */
  readonly inboundEvent: unknown;
  /** The model's `out_of_stock` digest (`productId`, `name`, optionals). */
  readonly digest: unknown;
  readonly restockFeatureEnabled?: unknown;
}

export interface RestockPreflightDeps {
  readonly conversation: Pick<ConversationStore, 'get'>;
  readonly markers: SharedRouteMarkersPort;
  /** Fresh trusted catalog read; the ONLY authority for the RESTOCK intake. */
  readonly catalog: Pick<ChatbotApiClient, 'getStock'>;
}

export type RestockPreflightBlockReason =
  | 'identity_unbound'
  | 'marker_read_failed'
  | 'invalid_digest'
  | 'catalog_read_failed'
  | 'catalog_unverified'
  | 'existing_legacy'
  | 'existing_restock'
  | 'conflicting_markers'
  | 'indeterminate_marker_state'
  | 'route_not_available';

export type RestockPreflightOutcome =
  | { readonly route: 'legacy' }
  | { readonly route: 'restock'; readonly intake: RestockIntakeInput }
  | { readonly route: 'blocked'; readonly reason: RestockPreflightBlockReason };

const blocked = (
  reason: RestockPreflightBlockReason,
): RestockPreflightOutcome => ({ route: 'blocked', reason });

/** Default-off: only a literal `true` leaves the exact legacy path. */
function featureEnabled(input: RestockPreflightInput): boolean {
  try {
    return input.restockFeatureEnabled === true;
  } catch {
    return false;
  }
}

/** Either source indeterminate => indeterminate; otherwise the union. */
function combineUnknownWins(
  durable: SharedRouteMarkerState,
  conversation: boolean | 'unknown',
): SharedRouteMarkerState {
  if (durable === 'unknown' || conversation === 'unknown') return 'unknown';
  return durable || conversation;
}

function blockReasonFor(
  decision: Exclude<OutOfStockRouteDecision, { route: 'restock' }>,
): RestockPreflightBlockReason {
  switch (decision.route) {
    case 'existing_legacy':
      return 'existing_legacy';
    case 'existing_restock':
      return 'existing_restock';
    case 'blocked_conflict':
      return 'conflicting_markers';
    case 'blocked_indeterminate':
      return 'indeterminate_marker_state';
    default:
      return 'route_not_available';
  }
}

/** Mirrors the tool's `out_of_stock` digest schema; unknown keys are stripped. */
const DIGEST_SCHEMA = z.object({
  productId: z.uuid(),
  name: z.string().min(1),
  variantId: z.uuid().optional(),
  quantity: z.number().int().min(1).optional(),
});

interface RestockCandidate {
  readonly productId: string;
  /** Parsed for shape only; the BACKEND name is the one that reaches intake. */
  readonly name: string;
  readonly variantId: string | null;
}

/**
 * Parse and COPY the model digest, so the (possibly hostile) digest object is
 * never re-read afterwards. `quantity` is validated for shape only. `null` on a
 * malformed digest or a throwing getter.
 */
function parseCandidate(digest: unknown): RestockCandidate | null {
  const parsed = DIGEST_SCHEMA.safeParse(digest);
  if (!parsed.success) return null;
  return {
    productId: parsed.data.productId,
    name: parsed.data.name,
    variantId: parsed.data.variantId ?? null,
  };
}

/**
 * Verify the FRESH catalog read against the parsed candidate and build the
 * EXACT ten-key intake from BACKEND values only. `productName` is the backend
 * name and `requestedQuantity` is ALWAYS null (available stock is not a
 * requested quantity); a selected variant must be uniquely out of stock. Any
 * mismatch, malformed shape, or non-out-of-stock reading yields `null`.
 */
function verifiedIntake(
  stock: StockCheckResponse,
  candidate: RestockCandidate,
  sourceRequestId: string,
): RestockIntakeInput | null {
  try {
    if (stock.productId !== candidate.productId) return null;
    if (stock.stock.status !== 'out_of_stock' || stock.stock.quantity !== 0) {
      return null;
    }
    if (typeof stock.name !== 'string' || stock.name.trim().length === 0) {
      return null;
    }
    if (!Array.isArray(stock.variants)) return null;
    const variantIds = new Set<string>();
    for (const variant of stock.variants) {
      if (
        typeof variant !== 'object' ||
        variant === null ||
        !z.uuid().safeParse(variant.variantId).success ||
        typeof variant.name !== 'string' ||
        (variant.option !== null && typeof variant.option !== 'string') ||
        (variant.value !== null && typeof variant.value !== 'string') ||
        !variant.stock ||
        !['available', 'low_stock', 'out_of_stock', 'not_managed'].includes(
          variant.stock.status,
        ) ||
        (variant.stock.quantity !== null &&
          (!Number.isInteger(variant.stock.quantity) ||
            variant.stock.quantity < 0)) ||
        variantIds.has(variant.variantId)
      ) {
        return null;
      }
      variantIds.add(variant.variantId);
    }
    if (candidate.variantId !== null) {
      const matches = stock.variants.filter(
        (variant) => variant.variantId === candidate.variantId,
      );
      if (matches.length !== 1) return null;
      if (
        matches[0].stock.status !== 'out_of_stock' ||
        matches[0].stock.quantity !== 0
      ) {
        return null;
      }
    }
    return normalizeRestockIntake({
      sourceRequestId,
      type: 'RESTOCK',
      productId: candidate.productId,
      productName: stock.name,
      variantId: candidate.variantId,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: null,
      stockObservedAt: null,
      supersedesDecisionId: null,
    });
  } catch {
    return null;
  }
}

/**
 * Read-only preflight. See the module note: the outcome is a recommendation,
 * never a reservation.
 */
export async function preflightRestockRequest(
  input: RestockPreflightInput,
  deps: RestockPreflightDeps,
): Promise<RestockPreflightOutcome> {
  if (!featureEnabled(input)) return { route: 'legacy' };

  let senderId: string;
  let sourceRequestId: string;
  try {
    senderId = input.senderId;
    const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
    if (bound === null) return blocked('identity_unbound');
    sourceRequestId = bound.sourceRequestId;
  } catch {
    return blocked('identity_unbound');
  }

  let durableLegacy: SharedRouteMarkerState;
  let durableRestock: SharedRouteMarkerState;
  let state: ConversationState | null;
  try {
    const markers = await deps.markers.readForSender(senderId);
    durableLegacy = markers.legacyRequestPending;
    durableRestock = markers.restockIntentPresent;
    state = await deps.conversation.get(senderId);
  } catch {
    return blocked('marker_read_failed');
  }

  const conversation = classifyRestockConversationLegacyMarker(state, senderId);
  const decision = selectOutOfStockRoute({
    restockFeatureEnabled: true,
    legacyRequestPending: combineUnknownWins(durableLegacy, conversation),
    restockIntentPresent: durableRestock,
  });
  if (decision.route !== 'restock') return blocked(blockReasonFor(decision));

  let candidate: RestockCandidate | null;
  try {
    candidate = parseCandidate(input.digest);
  } catch {
    candidate = null;
  }
  if (candidate === null) return blocked('invalid_digest');

  let stock: StockCheckResponse;
  try {
    stock = await deps.catalog.getStock(candidate.productId);
  } catch {
    return blocked('catalog_read_failed');
  }

  const intake = verifiedIntake(stock, candidate, sourceRequestId);
  return intake === null
    ? blocked('catalog_unverified')
    : { route: 'restock', intake };
}
