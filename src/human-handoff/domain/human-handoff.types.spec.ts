import {
  HUMAN_HANDOFF_KINDS,
  type HumanHandoffDigest,
  type HumanHandoffKind,
  type HumanHandoffRequest,
  type HumanHandoffResolution,
} from './human-handoff.types';

/**
 * Contract tests for the human-handoff domain types.
 *
 * Spec scenarios (human-handoff §"HumanHandoffKind discriminated union"):
 *   - HumanHandoffKind has four members (three active + one reserved for R6).
 *   - HumanHandoffDigest is a discriminated union with one shape per kind.
 *   - HumanHandoffResolution is a five-member discriminated union.
 *   - HumanHandoffRequest carries the full lifecycle record shape.
 */
describe('human-handoff.domain.types', () => {
  it('HumanHandoffKind union has four members (three active + reserved shipping_approval for R6)', () => {
    expect(HUMAN_HANDOFF_KINDS).toEqual([
      'out_of_stock',
      'needs_human_review',
      'expiration_date',
      'shipping_approval',
    ]);
  });

  it('HumanHandoffDigest discriminated union accepts all three active-kind shapes', () => {
    const outOfStock: HumanHandoffDigest = {
      productId: '00000000-0000-4000-8000-000000000001',
      name: 'Croquetas',
      quantity: 2,
    };
    const needsHumanReview: HumanHandoffDigest = {
      items: [
        {
          productId: '00000000-0000-4000-8000-000000000001',
          quantity: 1,
          unitPriceCents: 100,
        },
      ],
      originalTotalCents: 100,
    };
    const expirationDate: HumanHandoffDigest = {
      productId: '00000000-0000-4000-8000-000000000001',
      name: 'Croquetas',
      question: '¿cuál es la fecha de caducidad?',
    };
    // Compile-time check: each variant satisfies the union.
    const digests: HumanHandoffDigest[] = [
      outOfStock,
      needsHumanReview,
      expirationDate,
    ];
    expect(digests).toHaveLength(3);
  });

  it('HumanHandoffResolution union has five members', () => {
    const restock: HumanHandoffResolution = {
      decision: 'YES_RESTOCK_IN_X_DAYS',
      days: 3,
    };
    const noRestock: HumanHandoffResolution = { decision: 'NO_RESTOCK' };
    const approvedPromo: HumanHandoffResolution = {
      decision: 'APPROVED_PROMO',
      totalCents: 89000,
    };
    const expiration: HumanHandoffResolution = {
      decision: 'EXPIRATION',
      text: 'vence el 30 de noviembre',
    };
    const generic: HumanHandoffResolution = {
      decision: 'GENERIC',
      text: 'alguna nota',
    };
    const resolutions: HumanHandoffResolution[] = [
      restock,
      noRestock,
      approvedPromo,
      expiration,
      generic,
    ];
    expect(resolutions).toHaveLength(5);
  });

  it('HumanHandoffRequest carries the full lifecycle record shape', () => {
    const request: HumanHandoffRequest = {
      id: 'abc123def456',
      customerId: 'S',
      agentId: 'OPS',
      kind: 'out_of_stock' satisfies HumanHandoffKind,
      digest: {
        productId: '00000000-0000-4000-8000-000000000001',
        name: 'Croquetas',
      },
      status: 'pending',
      resolution: null,
      createdAt: '2026-06-23T12:00:00.000Z',
      resolvedAt: null,
    };
    expect(request.status).toBe('pending');
    expect(request.resolvedAt).toBeNull();
  });
});
