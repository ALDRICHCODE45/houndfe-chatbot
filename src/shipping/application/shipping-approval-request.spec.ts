/**
 * SQ-5C3b1 core lifecycle: one server-owned `shipping_approval` handoff plus
 * the row-create race guard. Self-contained and fully offline so this unit can
 * be committed without the shared b2/b3 fixture. Marker, digest-drift, hostile
 * seam, and clock coverage lives in the adversarial and hostile specs.
 */
import type { ConversationState } from '../../conversation/domain/conversation-store';
import type {
  HumanHandoffCreateInput,
  HumanHandoffCreateResult,
} from '../../human-handoff/application/human-handoff.service';
import type { HumanHandoffRequest } from '../../human-handoff/domain/human-handoff.types';
import { buildShippingApprovalDigest } from './shipping-approval';
import { buildShippingQuoteDraftRecord } from './shipping-quote-draft-record';
import {
  requestShippingApproval,
  type ShippingApprovalRequestDeps,
} from './shipping-approval-request';

const NOW_MS = Date.parse('2026-06-23T12:00:00.000Z');
const NOW_ISO = '2026-06-23T12:00:00.000Z';
const SENDER = '5215500000000';
const ID = 'abcdef123456';
const REF = `HF-${ID}`;
const PENDING = {
  requestId: ID,
  ref: REF,
  createdAt: NOW_ISO,
  customerNotifiedAt: NOW_ISO,
};
const DRAFT = {
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

const draftRecord = () => buildShippingQuoteDraftRecord(DRAFT, NOW_MS)!;
const digest = () => buildShippingApprovalDigest(draftRecord(), NOW_MS)!;
const stateWith = (data: Record<string, unknown>): ConversationState => ({
  senderId: SENDER,
  lastMessageAt: NOW_ISO,
  data: { shippingQuoteDraft: draftRecord(), ...data },
});
const rowOf = (
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

/** Minimal offline seam set: a stored draft, one successful create that sets
 *  the canonical pending marker, one injected row, and a fixed clock. */
function buildDeps(row: HumanHandoffRequest | null = rowOf()) {
  let stored: ConversationState | null = stateWith({});
  const createInputs: HumanHandoffCreateInput[] = [];
  const create = jest.fn(
    (input: HumanHandoffCreateInput): Promise<HumanHandoffCreateResult> => {
      createInputs.push(input);
      stored = stateWith({ pendingHumanRequest: PENDING });
      return Promise.resolve({
        ok: true,
        requestId: ID,
        ref: REF,
        customerNotified: true,
      });
    },
  );
  const deps: ShippingApprovalRequestDeps = {
    conversationStore: { get: jest.fn(() => Promise.resolve(stored)) },
    handoffCreator: { create },
    handoffRows: { findById: jest.fn(() => Promise.resolve(row)) },
    now: jest.fn(() => NOW_MS),
  };
  return { deps, createInputs };
}

describe('requestShippingApproval', () => {
  it('creates one shipping_approval handoff and returns a frozen price-free success', async () => {
    const c = buildDeps();
    const result = await requestShippingApproval(c.deps, SENDER);
    expect(result).toEqual({ ok: true });
    expect(Object.keys(result)).toEqual(['ok']);
    expect(Object.isFrozen(result)).toBe(true);
    expect('digest' in result).toBe(false);
    expect('ref' in result).toBe(false);
    expect('requestId' in result).toBe(false);
    expect(c.createInputs).toEqual([
      { senderId: SENDER, kind: 'shipping_approval', digest: digest() },
    ]);
    expect(Object.keys(c.createInputs[0]).sort()).toEqual([
      'digest',
      'kind',
      'senderId',
    ]);
  });

  it('rejects a wrong-kind, absent, or foreign row after the create race', async () => {
    const wrongKind = buildDeps(rowOf({ kind: 'needs_human_review' }));
    const absent = buildDeps(null);
    const foreign = buildDeps(rowOf({ customerId: 'other' }));
    for (const c of [wrongKind, absent, foreign]) {
      expect(await requestShippingApproval(c.deps, SENDER)).toEqual({
        ok: false,
        reason: 'verification_failed',
      });
    }
  });

  it('fails closed when the draft expires during the final async read', async () => {
    const c = buildDeps();
    const expires = Date.parse(draftRecord().expiresAt);
    let reads = 0;
    const get = jest.fn(async (senderId: string) => {
      reads += 1;
      return c.deps.conversationStore.get(senderId);
    });
    const now = jest.fn(() => (reads >= 2 ? expires : NOW_MS));
    const deps = { ...c.deps, conversationStore: { get }, now };
    expect(await requestShippingApproval(deps, SENDER)).toEqual({
      ok: false,
      reason: 'verification_failed',
    });
  });
});
