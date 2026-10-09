import type { ModelMessage } from 'ai';
import type { MinimalCartSelectionSnapshot } from './minimal-cart-selections';
import type { MinimalCartPendingRequest } from './minimal-cart-quantity';

/** DI injection token for the MinimalCatalogSessionStore port. */
export const MINIMAL_CATALOG_SESSION_STORE = Symbol(
  'MINIMAL_CATALOG_SESSION_STORE',
);

/**
 * Server-owned cart state for one sender, retained across turns even when the
 * cart-reply branch discards the SDK response messages.
 *
 * `selections` is the bounded, detached registry snapshot the service rebuilds
 * its opaque selection references from; `pending` is a single grounded
 * quantity intent (product + operation + optional count) that may be carried
 * into the same request. It is never model-authored: the service derives both
 * from verified tool output.
 */
export type MinimalCartConversationContext = {
  selections: MinimalCartSelectionSnapshot;
  pending: MinimalCartPendingRequest | null;
};

/**
 * One whole turn per sender: the user message, the model/tool response
 * messages, and only the productIds a successful fresh search produced.
 *
 * `messages` and `verifiedProductIds` are kept together so a later turn can
 * flatten the retained messages and union the verified identity. `cartContext`
 * carries the owned selection snapshot and pending intent for the cart route.
 */
export type MinimalCatalogTurn = {
  messages: ModelMessage[];
  verifiedProductIds: string[];
  cartContext?: MinimalCartConversationContext;
};

/**
 * Per-sender session history for the experimental read-only catalog route.
 *
 * The port is a deliberately minimal read/write map of retained turns; the
 * service owns the `historyTurns` retention policy (the `slice(-historyTurns)`
 * read and the `prior + current` write) at its call sites. The adapter is
 * in-memory only: a fresh process — or a fresh store instance — forgets every
 * sender (restart loss).
 */
export interface MinimalCatalogSessionStore {
  /** Retained turns for a sender in insertion order; [] when unknown. */
  read(senderId: string): MinimalCatalogTurn[];

  /** Replaces the sender's retained turns. */
  write(senderId: string, turns: MinimalCatalogTurn[]): void;
}
