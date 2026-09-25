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
 * Reasons are fixed codes only; no PII, digest text, or ids are returned.
 */
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
}

export type RestockPreflightBlockReason =
  | 'identity_unbound'
  | 'marker_read_failed'
  | 'invalid_digest'
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

/**
 * Build the EXACT ten-key intake from the model digest plus the server-derived
 * `sourceRequestId`. The digest's own `sourceRequestId` (if any) is never read.
 * `quantity` in the existing checkStock envelope is AVAILABLE STOCK, not a
 * verified customer-requested quantity; never mislabel it as requestedQuantity.
 * Its positive-integer shape is checked if present, but intake sends null.
 * Other absent optionals map to null; malformed digest yields null.
 */
function buildIntake(
  digest: unknown,
  sourceRequestId: string,
): RestockIntakeInput | null {
  try {
    if (typeof digest !== 'object' || digest === null) return null;
    // SAFETY: `digest` is narrowed to a non-null object; every value below is
    // handed to `normalizeRestockIntake`, which validates all ten fields.
    const fields = digest as Record<string, unknown>;
    if (
      fields.quantity !== undefined &&
      (typeof fields.quantity !== 'number' ||
        !Number.isInteger(fields.quantity) ||
        fields.quantity < 1)
    ) {
      return null;
    }
    return normalizeRestockIntake({
      sourceRequestId,
      type: 'RESTOCK',
      productId: fields.productId,
      productName: fields.name,
      variantId: fields.variantId ?? null,
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

  const intake = buildIntake(input.digest, sourceRequestId);
  return intake === null
    ? blocked('invalid_digest')
    : { route: 'restock', intake };
}
