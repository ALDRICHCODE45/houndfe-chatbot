import type { ConversationState } from '../../conversation/domain/conversation-store';
import { buildShippingQuoteDraftRecord } from './shipping-quote-draft-record';
import {
  DRAFT,
  ID,
  NOW_ISO,
  NOW_MS,
  PENDING,
  REF,
  SENDER,
  deny,
  draftRecord,
  mk,
  rowOf,
  stateWith,
  type TestCtx,
} from '../../../test/fixtures/shipping-approval-request-fixture';
import { requestShippingApproval } from './shipping-approval-request';

/** SQ-5C3b3 hostile-boundary characterization: throwing getters and proxies on
 *  the row, the create result, and the fresh state must resolve a price-free
 *  failure instead of rejecting. Same-pin draft drift with changed carrier or
 *  financials is rejected by the rebuilt digest. */
const fresh = (ctx: TestCtx, second: ConversationState | null): void => {
  ctx.get.mockReset();
  ctx.get.mockResolvedValueOnce(stateWith({})).mockResolvedValueOnce(second);
};

describe('requestShippingApproval', () => {
  it('resolves a price-free failure when a row getter or proxy throws', async () => {
    const throwingKind = rowOf();
    Object.defineProperty(throwingKind, 'kind', {
      get() {
        throw new Error('hostile kind');
      },
    });
    const hostileProxy = new Proxy(rowOf(), {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        throw new Error('hostile row');
      },
    });
    for (const row of [throwingKind, hostileProxy]) {
      const c = mk({ row });
      await expect(requestShippingApproval(c.deps, SENDER)).resolves.toEqual(
        deny('verification_failed'),
      );
    }
  });

  it('resolves a price-free failure when the created result getters throw', async () => {
    const hostile = {
      ok: true,
      requestId: ID,
      ref: REF,
      customerNotified: true,
    };
    Object.defineProperty(hostile, 'customerNotified', {
      get() {
        throw new Error('hostile created');
      },
    });
    const c = mk({ createValue: hostile });
    await expect(requestShippingApproval(c.deps, SENDER)).resolves.toEqual(
      deny('handoff_failed'),
    );
  });

  it('rejects unstable create-result getters that change after first read', async () => {
    const OTHER = 'ffffffffffff';
    let requestIdReads = 0;
    let refReads = 0;
    const hostile = {
      ok: true,
      customerNotified: true,
      get requestId() {
        requestIdReads += 1;
        return requestIdReads <= 2 ? ID : OTHER;
      },
      get ref() {
        refReads += 1;
        return refReads === 1 ? REF : `HF-${OTHER}`;
      },
    };
    const c = mk({ createValue: hostile, row: rowOf({ id: OTHER }) });
    fresh(
      c,
      stateWith({
        pendingHumanRequest: {
          ...PENDING,
          requestId: OTHER,
          ref: `HF-${OTHER}`,
        },
      }),
    );
    expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
      deny('verification_failed'),
    );
  });

  it('resolves a price-free failure when the fresh shippingApproval getter throws', async () => {
    const data: Record<string, unknown> = {
      shippingQuoteDraft: draftRecord(),
      pendingHumanRequest: PENDING,
    };
    Object.defineProperty(data, 'shippingApproval', {
      get() {
        throw new Error('hostile approval');
      },
    });
    const c = mk();
    fresh(c, { senderId: SENDER, lastMessageAt: NOW_ISO, data });
    await expect(requestShippingApproval(c.deps, SENDER)).resolves.toEqual(
      deny('verification_failed'),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'carrier',
      { selectedRate: { ...DRAFT.selectedRate, carrierName: 'Other Express' } },
    ],
    [
      'financials',
      {
        bestRateCents: 19_000,
        selectedRate: { ...DRAFT.selectedRate, priceCents: 19_000 },
        customerPaysCents: 7_000,
      },
    ],
  ])(
    'rejects a fresh draft whose %s changed even when the pin matches',
    async (_label, patch) => {
      const drifted = buildShippingQuoteDraftRecord(
        { ...DRAFT, ...patch },
        NOW_MS,
      );
      expect(drifted).not.toBeNull();
      const c = mk();
      fresh(
        c,
        stateWith({
          pendingHumanRequest: PENDING,
          shippingQuoteDraft: drifted,
        }),
      );
      expect(await requestShippingApproval(c.deps, SENDER)).toEqual(
        deny('verification_failed'),
      );
    },
  );
});
