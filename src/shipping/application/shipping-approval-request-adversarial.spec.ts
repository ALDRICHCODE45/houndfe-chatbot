import type { ConversationState } from '../../conversation/domain/conversation-store';
import type {
  HumanHandoffRequest,
  ShippingApprovalDigest,
} from '../../human-handoff/domain/human-handoff.types';
import {
  ID,
  NOW_ISO,
  NOW_MS,
  PENDING,
  SENDER,
  deny,
  digest,
  draftRecord,
  mk,
  rowOf,
  stateWith,
  type TestCtx,
} from '../../../test/fixtures/shipping-approval-request-fixture';
import {
  requestShippingApproval,
  type ShippingApprovalRequestFailure,
} from './shipping-approval-request';

/** SQ-5C3b2 adversarial characterization: pending/prior markers, malformed
 *  rows and create results, async clock expiry, and input purity. Hostile
 *  getters/proxies and same-pin draft drift live in the hostile spec. */
const EXPIRES_MS = Date.parse('2026-06-23T12:30:00.000Z');
const SECRET = 'svc_secret_token';

const PRIOR = {
  requestId: ID,
  draftCreatedAt: NOW_ISO,
  decision: 'SHIPPING_APPROVED',
  decidedAt: NOW_ISO,
};

const fresh = (ctx: TestCtx, second: ConversationState | null): void => {
  ctx.get.mockReset();
  ctx.get.mockResolvedValueOnce(stateWith({})).mockResolvedValueOnce(second);
};

describe('requestShippingApproval', () => {
  it('exposes six finite failure reasons', () => {
    const reasons: ShippingApprovalRequestFailure[] = [
      'unavailable',
      'pending_handoff',
      'prior_decision',
      'malformed_state',
      'handoff_failed',
      'verification_failed',
    ];
    expect(new Set(reasons).size).toBe(6);
  });

  it('fails closed on expired, malformed, or missing drafts and bad clocks', async () => {
    const cases = [
      mk({ clock: [NOW_MS - 1] }),
      mk({ clock: [EXPIRES_MS] }),
      mk({ clock: [Number.NaN] }),
      mk({ stored: stateWith({ shippingQuoteDraft: { schemaVersion: 2 } }) }),
      mk({ stored: stateWith({ shippingQuoteDraft: null }) }),
      mk({ stored: null }),
    ];
    for (const c of cases) {
      expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
        deny('unavailable'),
      );
      expect(c.create).not.toHaveBeenCalled();
    }
  });

  it('blocks existing pending or prior markers without calling create', async () => {
    const pending = mk({ stored: stateWith({ pendingHumanRequest: PENDING }) });
    const drifted = mk({
      stored: stateWith({ pendingHumanRequest: { ...PENDING, ref: 'HF-x' } }),
    });
    const prior = mk({ stored: stateWith({ shippingApproval: PRIOR }) });
    const malformed = mk({ stored: stateWith({ shippingApproval: 'yes' }) });
    expect(await requestShippingApproval(pending.deps, SENDER)).toEqual(
      deny('pending_handoff'),
    );
    expect(await requestShippingApproval(drifted.deps, SENDER)).toEqual(
      deny('pending_handoff'),
    );
    expect(await requestShippingApproval(prior.deps, SENDER)).toEqual(
      deny('prior_decision'),
    );
    expect(await requestShippingApproval(malformed.deps, SENDER)).toEqual(
      deny('prior_decision'),
    );
    for (const c of [pending, drifted, prior, malformed]) {
      expect(c.create).not.toHaveBeenCalled();
    }
  });

  it('fails closed when the create seam is disabled or throws', async () => {
    const disabled = mk({
      create: { ok: false, error: { kind: 'disabled', retryable: false } },
    });
    const thrown = mk({ create: new Error('seam') });
    expect(await requestShippingApproval(disabled.deps, SENDER)).toEqual(
      deny('handoff_failed'),
    );
    expect(await requestShippingApproval(thrown.deps, SENDER)).toEqual(
      deny('handoff_failed'),
    );
  });

  it('rejects a malformed create requestId/ref', async () => {
    const bad = mk({
      create: {
        ok: true,
        requestId: 'ZZZ',
        ref: 'nope',
        customerNotified: true,
      },
    });
    expect(await requestShippingApproval(bad.deps, SENDER)).toEqual(
      deny('handoff_failed'),
    );
  });

  it.each<[string, Partial<HumanHandoffRequest>]>([
    ['resolved status', { status: 'resolved' }],
    ['recorded resolution', { resolution: { decision: 'NO_RESTOCK' } }],
    ['foreign id', { id: 'ffffffffffff' }],
  ])('rejects a malformed row (%s)', async (_label, over) => {
    const c = mk({ row: rowOf(over) });
    expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
      deny('verification_failed'),
    );
  });

  it.each<[string, Partial<ShippingApprovalDigest>]>([
    ['draft pin', { draftCreatedAt: '2026-06-23T11:00:00.000Z' }],
    ['customer pays', { customerPaysCents: 1 }],
    ['total credit', { totalCreditCents: 1 }],
    ['carrier', { carrierName: 'Other' }],
    ['service', { serviceName: 'Other' }],
    ['eta', { estimatedDeliveryDays: 9 }],
  ])('rejects a same-kind row mismatching %s', async (_label, patch) => {
    const c = mk({ row: rowOf({ digest: { ...digest(), ...patch } }) });
    expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
      deny('verification_failed'),
    );
  });

  it('rejects a missing, wrong, or noncanonical fresh marker', async () => {
    const missing = mk();
    fresh(missing, stateWith({}));
    const wrong = mk();
    fresh(
      wrong,
      stateWith({
        pendingHumanRequest: { ...PENDING, requestId: 'ffffffffffff' },
      }),
    );
    const extended = mk();
    fresh(extended, stateWith({ pendingHumanRequest: { ...PENDING, x: 1 } }));
    for (const c of [missing, wrong, extended]) {
      expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
        deny('verification_failed'),
      );
    }
  });

  it('rejects a prior decision and a replaced fresh draft', async () => {
    const decided = mk();
    fresh(
      decided,
      stateWith({ pendingHumanRequest: PENDING, shippingApproval: PRIOR }),
    );
    const replaced = mk();
    fresh(
      replaced,
      stateWith({
        pendingHumanRequest: PENDING,
        shippingQuoteDraft: {
          ...draftRecord(),
          createdAt: NOW_ISO,
          expiresAt: NOW_ISO,
        },
      }),
    );
    for (const c of [decided, replaced]) {
      expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
        deny('verification_failed'),
      );
    }
  });

  it('fails closed when the draft expires during the async create', async () => {
    const c = mk({ clock: [NOW_MS, EXPIRES_MS] });
    expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
      deny('verification_failed'),
    );
  });

  it('never mutates its inputs and leaks no price or secret', async () => {
    const input = stateWith({});
    const c = mk({ stored: input });
    const before = JSON.stringify(input);
    const result = await requestShippingApproval(c.deps, SENDER);
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(result)).not.toContain('6900');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
