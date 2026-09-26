/**
 * Shared offline builders for the SQ-5C3b shipping-approval request specs.
 * Test-only: every seam is injected, so no live store, network, or clock runs.
 */
import type { ConversationState } from '../../src/conversation/domain/conversation-store';
import type {
  HumanHandoffCreateInput,
  HumanHandoffCreateResult,
} from '../../src/human-handoff/application/human-handoff.service';
import type { HumanHandoffRequest } from '../../src/human-handoff/domain/human-handoff.types';
import { buildShippingApprovalDigest } from '../../src/shipping/application/shipping-approval';
import { buildShippingQuoteDraftRecord } from '../../src/shipping/application/shipping-quote-draft-record';
import type {
  ShippingApprovalRequestDeps,
  ShippingApprovalRequestFailure,
} from '../../src/shipping/application/shipping-approval-request';

export const NOW_MS = Date.parse('2026-06-23T12:00:00.000Z');
export const NOW_ISO = '2026-06-23T12:00:00.000Z';
export const SENDER = '5215500000000';
export const ID = 'abcdef123456';
export const REF = `HF-${ID}`;

export const PENDING = {
  requestId: ID,
  ref: REF,
  createdAt: NOW_ISO,
  customerNotifiedAt: NOW_ISO,
};

export const DRAFT = {
  quoteId: 'q1',
  selectedRate: {
    rateId: 'r1',
    carrierName: 'Skydropx Express',
    serviceName: 'DHL Express',
    priceCents: 18_900,
    currency: 'MXN',
    estimatedDeliveryDays: 3,
    validUntil: null,
  },
  providerExpiresAt: null,
  bestRateCents: 18_900,
  totalCreditCents: 12_000,
  appliedCreditCents: 12_000,
  unusedCreditCents: 0,
  qualifyingUnitCount: 1,
  customerPaysCents: 6_900,
};

export const draftRecord = () => buildShippingQuoteDraftRecord(DRAFT, NOW_MS)!;

/** The exact redacted digest the production gate rebuilds from the draft. */
export const digest = () => buildShippingApprovalDigest(draftRecord(), NOW_MS)!;

export const stateWith = (
  data: Record<string, unknown>,
): ConversationState => ({
  senderId: SENDER,
  lastMessageAt: NOW_ISO,
  data: { shippingQuoteDraft: draftRecord(), ...data },
});

export const okCreate = (): HumanHandoffCreateResult => ({
  ok: true,
  requestId: ID,
  ref: REF,
  customerNotified: true,
});

export const rowOf = (
  over: Partial<HumanHandoffRequest> = {},
): HumanHandoffRequest => ({
  id: ID,
  customerId: SENDER,
  agentId: 'ops',
  kind: 'shipping_approval',
  digest: digest(),
  status: 'pending',
  resolution: null,
  createdAt: NOW_ISO,
  resolvedAt: null,
  ...over,
});

/** Minimal jest surface, declared locally: no `@types/jest` needed to build. */
export type Mock<T> = {
  (...args: never[]): T;
  mockReset(): void;
  mockResolvedValueOnce(value: Awaited<T>): Mock<T>;
};
declare const jest: { fn: <T>(impl: (...args: never[]) => T) => Mock<T> };

export const mk = (
  over: {
    stored?: ConversationState | null;
    create?: HumanHandoffCreateResult | Error;
    /** Returned verbatim by the create seam, without dereferencing it. */
    createValue?: unknown;
    row?: HumanHandoffRequest | null | Error;
    clock?: number[];
  } = {},
) => {
  let stored = over.stored === undefined ? stateWith({}) : over.stored;
  const createInputs: HumanHandoffCreateInput[] = [];
  const get = jest.fn(() => Promise.resolve(stored));
  const create = jest.fn(
    (input: HumanHandoffCreateInput): Promise<HumanHandoffCreateResult> => {
      createInputs.push(input);
      if ('createValue' in over) {
        return Promise.resolve(over.createValue as HumanHandoffCreateResult);
      }
      if (over.create instanceof Error) return Promise.reject(over.create);
      const result = over.create ?? okCreate();
      if (result.ok) stored = stateWith({ pendingHumanRequest: PENDING });
      return Promise.resolve(result);
    },
  );
  const findById = jest.fn(
    (): Promise<HumanHandoffRequest | null> =>
      over.row instanceof Error
        ? Promise.reject(over.row)
        : Promise.resolve(over.row === undefined ? rowOf() : over.row),
  );
  const ticks = over.clock ?? [NOW_MS];
  let i = 0;
  const now = jest.fn(() => ticks[Math.min(i++, ticks.length - 1)]);
  const deps: ShippingApprovalRequestDeps = {
    conversationStore: { get },
    handoffCreator: { create },
    handoffRows: { findById },
    now,
  };
  return { deps, get, create, createInputs, findById };
};

export type TestCtx = ReturnType<typeof mk>;

export function deny(reason: ShippingApprovalRequestFailure) {
  return { ok: false, reason };
}
