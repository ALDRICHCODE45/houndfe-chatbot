import { z } from 'zod';
import type { ConversationGateState } from '../../../conversation-gates/application/conversation-gates';
import { CatalogSession } from '../../../conversation/domain/catalog-references';

/** Serializable part of one pending RESTOCK question (S4). */
export interface RestockPendingData {
  readonly originPhoneNumberId: string;
  readonly originMessageId: string;
  readonly expiresAt: number;
  readonly session: CatalogSession;
  readonly digest: {
    readonly productId: string;
    readonly name: string;
    readonly variantId?: string;
  };
  readonly presentation: string;
  readonly proposal: string;
  readonly seen: ReadonlySet<string>;
  readonly armed: boolean;
}

const payloadSchema = z.strictObject({
  originPhoneNumberId: z.string().min(1),
  originMessageId: z.string().min(1),
  // Shape re-validated by the CatalogSession snapshot schema on restore.
  catalog: z.looseObject({ observedAt: z.iso.datetime() }),
  digest: z.strictObject({
    productId: z.uuid(),
    name: z.string().min(1),
    variantId: z.uuid().optional(),
  }),
  presentation: z.string().min(1).max(2048),
  seen: z.array(z.string().min(1)).max(16),
  armed: z.boolean(),
});

/** Payload of the durable `restock_pending` gate, or `null` when unusable. */
export function serializeRestockPending(
  pending: RestockPendingData,
): ConversationGateState | null {
  const refs = pending.session.snapshot();
  if (refs === null) return null;
  return {
    payload: {
      originPhoneNumberId: pending.originPhoneNumberId,
      originMessageId: pending.originMessageId,
      catalog: { ...refs, observedAt: new Date(refs.observedAt).toISOString() },
      digest: { ...pending.digest },
      presentation: pending.presentation,
      seen: [...pending.seen],
      armed: pending.armed,
    },
    expiresAt: pending.expiresAt,
  };
}

/**
 * Rebuild a pending question from a durable row, or `null` when the payload
 * is malformed, names another sender, or its catalog evidence no longer
 * validates (the question then counts as absent).
 */
export function restoreRestockPending(
  senderId: string,
  state: ConversationGateState,
  options: {
    readonly ttlMs: number;
    readonly clock: () => number;
    readonly proposal: (presentation: string) => string;
  },
): RestockPendingData | null {
  const parsed = payloadSchema.safeParse(state.payload);
  if (!parsed.success) return null;
  const { catalog, ...rest } = parsed.data;
  // The snapshot's origin message must be a retained user turn; the gate
  // keeps no transcript, so a placeholder stands in for it.
  const session = new CatalogSession(
    senderId,
    options.ttlMs,
    0,
    { ...catalog, observedAt: Date.parse(catalog.observedAt) },
    [{ role: 'user', content: '' }],
    options.clock,
  );
  if (session.snapshot() === null) return null;
  return {
    ...rest,
    expiresAt: state.expiresAt,
    session,
    proposal: options.proposal(rest.presentation),
    seen: new Set(rest.seen),
  };
}
