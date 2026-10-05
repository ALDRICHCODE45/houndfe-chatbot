import type { ExpirationExistingDecisionOutcome } from './expiration-existing-decision.service';
import { createExpirationPreparationCandidate } from './expiration-preparation-candidate';

const senderId = 'customer';
const branchId = ' branch ';
const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const productId = '44444444-4444-4444-8444-444444444444';
const at = '2026-06-23T08:00:00.000Z';
const deadline = '2026-06-24T08:00:00.000Z';
const fixture = () => ({
  outcome: 'resolved' as const,
  binding: {
    branchId,
    backendDecisionId: decisionId,
    reservation: {
      status: 'ACTIVE' as const,
      route: 'EXPIRATION' as const,
      senderId,
      requestKey: sourceRequestId,
      intake: {
        sourceRequestId,
        type: 'EXPIRATION' as const,
        productId,
        variantId: null,
      },
    },
  },
  decision: {
    id: decisionId,
    sourceRequestId,
    type: 'EXPIRATION' as const,
    status: 'RESOLVED' as const,
    version: 2 as const,
    createdAt: at,
    snapshot: {
      branchId,
      branchName: null,
      productId,
      productName: 'Food',
      unit: 'PZA',
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    },
    supersedesDecisionId: null,
    resolution: {
      action: 'PROVIDE_EXPIRATION_TEXT' as const,
      expirationText: 'Vence 03/2027',
      resolvedAt: at,
    },
    applyBefore: deadline,
  },
});
const build = (outcome: unknown, checkedAt = at, sender = senderId) =>
  createExpirationPreparationCandidate(
    sender,
    outcome as ExpirationExistingDecisionOutcome,
    checkedAt,
  );
const hold = { action: 'hold' };

describe('inactive EXPIRATION preparation candidate', () => {
  it.each([
    'PROVIDE_EXPIRATION_TEXT',
    'REPORT_EXPIRATION_UNAVAILABLE',
  ] as const)(
    'preserves original binding and %s resolution as a detached immutable candidate',
    (action) => {
      const original = fixture();
      const outcome =
        action === 'PROVIDE_EXPIRATION_TEXT'
          ? original
          : {
              ...original,
              decision: {
                ...original.decision,
                resolution: { action, resolvedAt: at },
              },
            };
      const before = structuredClone(outcome);
      const candidate = build(outcome);
      expect(candidate).toEqual({
        action: 'candidate',
        binding: before.binding,
        decision: before.decision,
        checkedAt: at,
      });
      expect(outcome).toEqual(before);
      if (candidate.action !== 'candidate')
        throw new Error('missing candidate');
      for (const value of [
        candidate,
        candidate.binding,
        candidate.binding.reservation,
        candidate.binding.reservation.intake,
        candidate.decision,
        candidate.decision.snapshot,
        candidate.decision.resolution,
      ]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      expect(candidate.binding).not.toBe(outcome.binding);
      expect(candidate.binding.reservation.intake).not.toBe(
        outcome.binding.reservation.intake,
      );
      expect(candidate.decision).not.toBe(outcome.decision);
      outcome.binding.reservation.intake.productId = decisionId;
      outcome.binding.branchId = 'changed';
      outcome.decision.snapshot.productName = 'changed';
      expect(candidate).toEqual({
        action: 'candidate',
        binding: before.binding,
        decision: before.decision,
        checkedAt: at,
      });
      expect(Object.isFrozen(outcome.binding)).toBe(false);
    },
  );

  it.each([at, '2026-06-24T07:59:59.999Z'])(
    'accepts the half-open validity window at %s',
    (checkedAt) => {
      expect(build(fixture(), checkedAt)).toEqual({
        action: 'candidate',
        binding: fixture().binding,
        decision: fixture().decision,
        checkedAt,
      });
    },
  );
  it.each([
    deadline,
    '2026-06-24T08:00:00.001Z',
    '2026-06-23T07:59:59.999Z',
    'bad',
    '2026-06-23T08:00:00Z',
  ])(
    'holds expired, premature or invalid time %s without changing input',
    (checkedAt) => {
      const outcome = fixture();
      const before = structuredClone(outcome);
      expect(build(outcome, checkedAt)).toEqual(hold);
      expect(outcome).toEqual(before);
    },
  );
  it('holds pending, held, failed and malformed outcomes', () => {
    const pending = {
      ...fixture(),
      outcome: 'pending',
      decision: {
        ...fixture().decision,
        status: 'PENDING',
        version: 1,
        resolution: null,
        applyBefore: null,
      },
    };
    for (const outcome of [
      pending,
      { outcome: 'held' },
      { outcome: 'query_failed' },
      null,
      {},
      { ...fixture(), decision: { ...fixture().decision, version: 1 } },
    ]) {
      const before = structuredClone(outcome);
      expect(build(outcome)).toEqual(hold);
      expect(outcome).toEqual(before);
    }
  });
  it('holds every original binding mismatch instead of rebinding the inquiry', () => {
    const original = fixture();
    const variants = [
      { ...original.binding, branchId: 'other' },
      { ...original.binding, backendDecisionId: productId },
      ...[
        { senderId: 'other' },
        { requestKey: productId },
        { status: 'INACTIVE' },
        { route: 'RESTOCK' },
        {
          intake: {
            ...original.binding.reservation.intake,
            productId: decisionId,
          },
        },
        {
          intake: {
            ...original.binding.reservation.intake,
            variantId: decisionId,
          },
        },
      ].map((patch) => ({
        ...original.binding,
        reservation: { ...original.binding.reservation, ...patch },
      })),
    ];
    for (const binding of variants) {
      const outcome = { ...original, binding };
      const before = structuredClone(outcome);
      expect(build(outcome)).toEqual(hold);
      expect(outcome).toEqual(before);
    }
    expect(build(original, at, 'other')).toEqual(hold);
  });
});
