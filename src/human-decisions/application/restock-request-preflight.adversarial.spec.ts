import { preflightRestockRequest } from './restock-request-preflight';

/**
 * HD-R3b3 adversarial spec for the inert RESTOCK request preflight: every
 * identity, durable-marker, conversation-marker, read, and digest failure must
 * BLOCK (never fall back to legacy once the feature is on). Positive paths live
 * in the base spec. The preflight is advisory — the final reserve CAS decides.
 */
const SENDER = 'whatsapp:+5215500000001';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const EVENT = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.ABC123',
};
const DIGEST = {
  productId: PRODUCT,
  name: 'Croquetas premium',
  variantId: VARIANT,
  quantity: 2,
};
const CLEAR = { legacyRequestPending: false, restockIntentPresent: false };
const PENDING_MARKER = {
  requestId: 'r1',
  ref: 'HF-r1',
  createdAt: '2026-06-23T12:00:00.000Z',
  customerNotifiedAt: '2026-06-23T12:00:01.000Z',
};
const STATE = (data: unknown, senderId = SENDER) => ({
  senderId,
  lastMessageAt: '2026-06-23T12:00:00.000Z',
  data,
});
const withSender = (senderId: unknown) => ({ ...EVENT, senderId });

const deps = (
  over: {
    markers?: unknown;
    state?: unknown;
    fail?: 'markers' | 'get';
  } = {},
) => {
  const readForSender = jest.fn().mockResolvedValue(over.markers ?? CLEAR);
  const get = jest.fn().mockResolvedValue(over.state ?? null);
  if (over.fail === 'markers') readForSender.mockRejectedValue(new Error('db'));
  if (over.fail === 'get') get.mockRejectedValue(new Error('db'));
  return {
    conversation: { get },
    markers: { readForSender },
    readForSender,
    get,
  };
};
const ask = (d: ReturnType<typeof deps>, over: Record<string, unknown> = {}) =>
  preflightRestockRequest(
    {
      senderId: SENDER,
      inboundEvent: EVENT,
      digest: DIGEST,
      restockFeatureEnabled: true,
      ...over,
    },
    d,
  );

describe('preflightRestockRequest (blocking)', () => {
  it('blocks a missing, mismatched, malformed, or hostile identity BEFORE any read', async () => {
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'receivingPhoneNumberId', {
      get: () => EVENT.receivingPhoneNumberId,
      enumerable: true,
    });
    const cases: unknown[] = [
      undefined,
      null,
      'x',
      {},
      { ...EVENT, senderId: 'whatsapp:+5215500000999' },
      { ...EVENT, extra: 'x' },
      { ...EVENT, messageId: 1 },
      withSender(null),
      accessor,
      new Proxy(
        { ...EVENT },
        {
          get: () => {
            throw new Error('boom');
          },
        },
      ),
    ];
    for (const inboundEvent of cases) {
      const d = deps();
      await expect(ask(d, { inboundEvent })).resolves.toEqual({
        route: 'blocked',
        reason: 'identity_unbound',
      });
      expect(d.readForSender).not.toHaveBeenCalled();
      expect(d.get).not.toHaveBeenCalled();
    }
  });

  it('blocks on durable legacy, restock, conflict, or unknown markers', async () => {
    const cases: Array<[unknown, string]> = [
      [
        { legacyRequestPending: true, restockIntentPresent: false },
        'existing_legacy',
      ],
      [
        { legacyRequestPending: false, restockIntentPresent: true },
        'existing_restock',
      ],
      [
        { legacyRequestPending: true, restockIntentPresent: true },
        'conflicting_markers',
      ],
      [
        { legacyRequestPending: 'unknown', restockIntentPresent: false },
        'indeterminate_marker_state',
      ],
      [
        { legacyRequestPending: false, restockIntentPresent: 'unknown' },
        'indeterminate_marker_state',
      ],
    ];
    for (const [markers, reason] of cases) {
      await expect(ask(deps({ markers }))).resolves.toEqual({
        route: 'blocked',
        reason,
      });
    }
  });

  it('blocks on a pending, malformed, or wrong-sender conversation marker', async () => {
    const cases: Array<[unknown, string]> = [
      [STATE({ pendingHumanRequest: PENDING_MARKER }), 'existing_legacy'],
      [
        STATE({ pendingHumanRequest: { requestId: 'r1' } }),
        'indeterminate_marker_state',
      ],
      [STATE({}, 'whatsapp:+5215500000999'), 'indeterminate_marker_state'],
    ];
    for (const [state, reason] of cases) {
      await expect(ask(deps({ state }))).resolves.toEqual({
        route: 'blocked',
        reason,
      });
    }
  });

  it('blocks when a marker read throws', async () => {
    for (const fail of ['markers', 'get'] as const) {
      await expect(ask(deps({ fail }))).resolves.toEqual({
        route: 'blocked',
        reason: 'marker_read_failed',
      });
    }
  });

  it('blocks an invalid digest without falling back to legacy', async () => {
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      {},
      { productId: 'nope', name: 'x' },
      { productId: PRODUCT, name: '' },
      { productId: PRODUCT, name: 'x', quantity: 0 },
      { productId: PRODUCT, name: 'x', variantId: 'nope' },
    ];
    for (const digest of bad) {
      await expect(ask(deps(), { digest })).resolves.toEqual({
        route: 'blocked',
        reason: 'invalid_digest',
      });
    }
  });
});
