import type { ModelMessage } from 'ai';

/** DI injection token for the MinimalCatalogSessionStore port. */
export const MINIMAL_CATALOG_SESSION_STORE = Symbol(
  'MINIMAL_CATALOG_SESSION_STORE',
);

/**
 * One whole turn per sender: the user message, the model/tool response
 * messages, and only the productIds a successful fresh search produced.
 *
 * `messages` and `verifiedProductIds` are kept together so a later turn can
 * flatten the retained messages and union the verified identity.
 */
export type MinimalCatalogTurn = {
  messages: ModelMessage[];
  verifiedProductIds: string[];
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
