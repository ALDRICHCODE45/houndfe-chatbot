import type { ConversationState } from '../../conversation/domain/conversation-store';
import {
  evaluateShippingSaleGate,
  type ShippingSaleGateVerdict,
} from './shipping-sale-gate';

/**
 * SQ-5D1 contract: a pure, fail-closed marker gate. No clock, I/O, async,
 * provider, or state mutation. It only asks whether the persisted
 * conversation state carries a server-written shipping marker that the
 * backend `CreateSaleInput` cannot yet price or persist as a sale charge.
 */
const ISO = '2026-06-23T12:00:00.000Z';
const DRAFT_KEY = 'shippingQuoteDraft';
const APPROVAL_KEY = 'shippingApproval';

const canonicalDraft = () => ({
  schemaVersion: 1,
  draft: {
    quoteId: 'q1',
    selectedRate: {
      rateId: 'r1',
      carrierName: 'Skydropx Express',
      serviceName: 'DHL Express',
      priceCents: 18900,
      currency: 'MXN',
      estimatedDeliveryDays: 3,
      validUntil: null,
    },
    providerExpiresAt: null,
    bestRateCents: 18900,
    totalCreditCents: 12000,
    appliedCreditCents: 12000,
    unusedCreditCents: 0,
    qualifyingUnitCount: 1,
    customerPaysCents: 6900,
  },
  createdAt: ISO,
  expiresAt: ISO,
});
const expiredDraft = () => ({
  ...canonicalDraft(),
  createdAt: '2020-01-01T00:00:00.000Z',
  expiresAt: '2020-01-01T00:30:00.000Z',
});
const approvalMarker = (decision: string) => ({
  requestId: 'abcdef123456',
  draftCreatedAt: ISO,
  decision,
  decidedAt: ISO,
});

const stateWith = (data: unknown): ConversationState => ({
  senderId: 'sender',
  lastMessageAt: ISO,
  data: data as ConversationState['data'],
});
const withGetter = (key: string, get: () => unknown) => {
  const data: Record<string, unknown> = {};
  Object.defineProperty(data, key, {
    enumerable: true,
    configurable: true,
    get,
  });
  return data;
};
const boom = (): never => {
  throw new Error('hostile getter');
};
const revokedProxy = (): unknown => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  return revoked.proxy;
};

describe('evaluateShippingSaleGate', () => {
  it('exposes exactly three finite verdict kinds', () => {
    const kinds: Array<ShippingSaleGateVerdict['kind']> = [
      'pass',
      'blocked',
      'malformed_state',
    ];
    expect(new Set(kinds).size).toBe(3);
  });

  it('returns frozen, exact-key verdicts', () => {
    const pass = evaluateShippingSaleGate(null);
    expect(pass).toEqual({ kind: 'pass' });
    expect(Object.keys(pass)).toEqual(['kind']);
    expect(Object.isFrozen(pass)).toBe(true);
    expect(evaluateShippingSaleGate('nope')).toEqual({
      kind: 'malformed_state',
    });
    expect(Object.isFrozen(evaluateShippingSaleGate('nope'))).toBe(true);
    expect(
      Object.isFrozen(
        evaluateShippingSaleGate(stateWith({ [DRAFT_KEY]: canonicalDraft() })),
      ),
    ).toBe(true);
  });

  it('passes a null state (gate runs after the cart read in D2)', () => {
    expect(evaluateShippingSaleGate(null)).toEqual({ kind: 'pass' });
  });

  it.each([
    ['no shipping keys', { messages: [], placedSaleId: 'sale-1' }],
    ['explicit null draft', { [DRAFT_KEY]: null }],
    ['explicit null approval', { [APPROVAL_KEY]: null }],
    ['both explicit null', { [DRAFT_KEY]: null, [APPROVAL_KEY]: null }],
    [
      'undefined marker values',
      { [DRAFT_KEY]: undefined, [APPROVAL_KEY]: undefined },
    ],
    [
      'unrelated keys',
      { cart: { items: [], idempotencyKey: '' }, messages: [] },
    ],
  ])('passes when no non-null marker is present (%s)', (_label, data) => {
    expect(evaluateShippingSaleGate(stateWith(data))).toEqual({ kind: 'pass' });
  });

  it('passes an address-only order; a delivery address is not a quote signal', () => {
    expect(
      evaluateShippingSaleGate(
        stateWith({ shippingAddressId: 'addr-1', placedSaleId: 'sale-1' }),
      ),
    ).toEqual({ kind: 'pass' });
  });

  it('does not mutate a frozen state', () => {
    const data = Object.freeze({ messages: Object.freeze([]) });
    const state = Object.freeze({ senderId: 's', lastMessageAt: ISO, data });
    expect(evaluateShippingSaleGate(state)).toEqual({ kind: 'pass' });
    expect(state).toEqual({ senderId: 's', lastMessageAt: ISO, data });
  });

  it.each([
    ['canonical draft', { [DRAFT_KEY]: canonicalDraft() }],
    ['expired draft', { [DRAFT_KEY]: expiredDraft() }],
    ['empty-object draft', { [DRAFT_KEY]: {} }],
    ['string draft', { [DRAFT_KEY]: 'quoted' }],
    ['number draft', { [DRAFT_KEY]: 0 }],
    ['false draft', { [DRAFT_KEY]: false }],
    ['empty-string draft', { [DRAFT_KEY]: '' }],
    [
      'approved marker',
      { [APPROVAL_KEY]: approvalMarker('SHIPPING_APPROVED') },
    ],
    [
      'rejected marker',
      { [APPROVAL_KEY]: approvalMarker('SHIPPING_REJECTED') },
    ],
    ['malformed approval', { [APPROVAL_KEY]: 'approved' }],
    ['Date marker value', { [DRAFT_KEY]: new Date() }],
    ['array marker value', { [DRAFT_KEY]: [] }],
    ['Map marker value', { [APPROVAL_KEY]: new Map() }],
    [
      'both present',
      {
        [DRAFT_KEY]: canonicalDraft(),
        [APPROVAL_KEY]: approvalMarker('SHIPPING_APPROVED'),
      },
    ],
  ])('blocks on any non-null shipping marker (%s)', (_label, data) => {
    expect(evaluateShippingSaleGate(stateWith(data))).toEqual({
      kind: 'blocked',
    });
  });

  it('blocks when a marker getter returns a non-null value', () => {
    expect(
      evaluateShippingSaleGate(stateWith(withGetter(DRAFT_KEY, () => ({})))),
    ).toEqual({ kind: 'blocked' });
  });

  it('ignores hostile getters on keys it never inspects', () => {
    const data = withGetter('messages', boom);
    expect(evaluateShippingSaleGate(stateWith(data))).toEqual({ kind: 'pass' });
  });

  it.each([
    ['undefined state', undefined],
    ['array state', []],
    ['string state', 'state'],
    ['number state', 42],
    ['revoked proxy state', revokedProxy()],
  ])('fails closed on non-plain state (%s)', (_label, state) => {
    expect(evaluateShippingSaleGate(state)).toEqual({
      kind: 'malformed_state',
    });
  });

  it.each([
    ['array data', []],
    ['string data', 'data'],
    ['number data', 7],
    ['boolean data', true],
    ['null data', null],
    ['undefined data', undefined],
    ['Map data', new Map()],
    ['Date data', new Date()],
  ])('fails closed on non-plain state.data (%s)', (_label, data) => {
    expect(evaluateShippingSaleGate(stateWith(data))).toEqual({
      kind: 'malformed_state',
    });
  });

  it('fails closed when reading state.data throws', () => {
    const state = { senderId: 's', lastMessageAt: ISO };
    Object.defineProperty(state, 'data', { get: boom });
    expect(evaluateShippingSaleGate(state)).toEqual({
      kind: 'malformed_state',
    });
  });

  it('fails closed when a marker getter throws', () => {
    expect(
      evaluateShippingSaleGate(stateWith(withGetter(APPROVAL_KEY, boom))),
    ).toEqual({ kind: 'malformed_state' });
  });

  it('reads each marker value exactly once so a stateful getter cannot flip the verdict', () => {
    let reads = 0;
    const data = withGetter(DRAFT_KEY, () => (reads++ === 0 ? null : 'late'));
    expect(evaluateShippingSaleGate(stateWith(data))).toEqual({ kind: 'pass' });
    expect(reads).toBe(1);
  });

  it('reads state.data exactly once', () => {
    let reads = 0;
    const state = {
      senderId: 's',
      lastMessageAt: ISO,
      get data() {
        return reads++ === 0 ? {} : { [DRAFT_KEY]: 'late' };
      },
    };
    expect(evaluateShippingSaleGate(state)).toEqual({ kind: 'pass' });
    expect(reads).toBe(1);
  });
});
