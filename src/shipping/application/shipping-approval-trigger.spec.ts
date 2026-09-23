import type { ConversationState } from '../../conversation/domain/conversation-store';
import type { ShippingQuoteDraft } from './shipping-quote-draft';
import { buildShippingQuoteDraftRecord } from './shipping-quote-draft-record';
import {
  prepareShippingApprovalRequest as prepare,
  type ShippingApprovalTriggerResult,
} from './shipping-approval-trigger';

/** SQ-5C3a contract: a pure, guarded preparation of the redacted
 *  `shipping_approval` digest. No I/O, model input, or state mutation. */
const NOW_MS = Date.parse('2026-06-23T12:00:00.000Z');
const NOW_ISO = '2026-06-23T12:00:00.000Z';
const EXPIRES_ISO = '2026-06-23T12:30:00.000Z';
const SECRET = 'svc_secret_token';
const DIGEST = {
  kind: 'shipping_approval',
  draftCreatedAt: NOW_ISO,
  customerPaysCents: 6_900,
  totalCreditCents: 12_000,
  carrierName: 'Skydropx Express',
  serviceName: 'DHL Express',
  estimatedDeliveryDays: 3,
} as const;
const PENDING = {
  requestId: 'abcdef123456',
  ref: 'HF-abcdef123456',
  createdAt: NOW_ISO,
  customerNotifiedAt: NOW_ISO,
};
const MARKER = {
  requestId: 'abcdef123456',
  draftCreatedAt: NOW_ISO,
  decision: 'SHIPPING_APPROVED',
  decidedAt: NOW_ISO,
};

const makeDraft = (): ShippingQuoteDraft => ({
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
});
const validRecord = () => buildShippingQuoteDraftRecord(makeDraft(), NOW_MS)!;
const stateWith = (data: Record<string, unknown>): ConversationState => ({
  senderId: 's',
  lastMessageAt: NOW_ISO,
  data,
});
const boom = (): never => {
  throw new Error('hostile get');
};
const revoked = (): unknown => {
  const r = Proxy.revocable({}, {});
  r.revoke();
  return r.proxy;
};
const readyDigest = (state: unknown, draft: unknown) => {
  const result = prepare(state, draft, NOW_MS);
  if (result.kind !== 'ready') {
    throw new Error(`expected ready, received ${result.kind}`);
  }
  return result.digest;
};

describe('prepareShippingApprovalRequest', () => {
  it('exposes exactly five finite result kinds', () => {
    const kinds: Array<ShippingApprovalTriggerResult['kind']> = [
      'ready',
      'pending_handoff',
      'prior_decision',
      'malformed_state',
      'unavailable',
    ];
    expect(new Set(kinds).size).toBe(5);
  });

  it('returns the exact frozen redacted digest for a valid state without markers', () => {
    const result = prepare(stateWith({ messages: [] }), validRecord(), NOW_MS);
    expect(result).toEqual({ kind: 'ready', digest: DIGEST });
    expect(Object.keys(result)).toEqual(['kind', 'digest']);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== 'ready') throw new Error('expected ready');
    expect(Object.keys(result.digest).sort()).toEqual(
      Object.keys(DIGEST).sort(),
    );
    expect(Object.isFrozen(result.digest)).toBe(true);
  });

  it('accepts a null conversation state with a valid draft', () => {
    expect(readyDigest(null, validRecord())).toEqual(DIGEST);
  });

  it.each([
    ['both null', { pendingHumanRequest: null, shippingApproval: null }],
    ['pending null', { pendingHumanRequest: null }],
    ['approval null', { shippingApproval: null }],
  ])('treats explicit JSON null markers as absent (%s)', (_label, data) => {
    expect(readyDigest(stateWith(data), validRecord())).toEqual(DIGEST);
  });

  it.each([
    ['canonical', PENDING],
    ['other handoff kind', { ...PENDING, kind: 'restock' }],
    ['noncanonical ref', { ...PENDING, ref: 'HF-other' }],
    ['extra key', { ...PENDING, priceCents: 1 }],
    ['string', 'pending'],
    ['number', 42],
    ['array', [PENDING]],
  ])('blocks any non-null pending marker (%s)', (_label, pending) => {
    const result = prepare(
      stateWith({ pendingHumanRequest: pending }),
      validRecord(),
      NOW_MS,
    );
    expect(result).toEqual({ kind: 'pending_handoff' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('short-circuits on a non-null pending marker before reading the approval getter', () => {
    let approvalReads = 0;
    const data: Record<string, unknown> = { pendingHumanRequest: PENDING };
    Object.defineProperty(data, 'shippingApproval', {
      enumerable: true,
      configurable: true,
      get(): never {
        approvalReads += 1;
        return boom();
      },
    });
    const result = prepare(stateWith(data), validRecord(), NOW_MS);
    expect(result).toEqual({ kind: 'pending_handoff' });
    expect(approvalReads).toBe(0);
  });

  it.each([
    ['approved', MARKER],
    ['rejected', { ...MARKER, decision: 'SHIPPING_REJECTED' }],
  ])('blocks a prior frozen decision marker (%s)', (_label, marker) => {
    const result = prepare(
      stateWith({ shippingApproval: marker }),
      validRecord(),
      NOW_MS,
    );
    expect(result).toEqual({ kind: 'prior_decision' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('never reopens a prior decision even against a fresh draft with a different pin', () => {
    const differentPin = {
      ...MARKER,
      draftCreatedAt: '2026-06-23T11:00:00.000Z',
    };
    expect(
      prepare(
        stateWith({ shippingApproval: differentPin }),
        validRecord(),
        NOW_MS,
      ),
    ).toEqual({ kind: 'prior_decision' });
  });

  it.each([
    ['extra key', { ...MARKER, priceCents: 1 }],
    ['empty object', {}],
    ['string', 'approved'],
    ['number', 1],
    ['array', [MARKER]],
  ])('blocks a malformed non-null decision marker (%s)', (_label, marker) => {
    expect(
      prepare(stateWith({ shippingApproval: marker }), validRecord(), NOW_MS),
    ).toEqual({ kind: 'prior_decision' });
  });

  it.each([
    ['string state', 'x'],
    ['number state', 42],
    ['undefined state', undefined],
    ['array state', []],
    ['missing data', { senderId: 's', lastMessageAt: NOW_ISO }],
    ['null data', { data: null }],
    ['array data', { data: [] }],
    ['string data', { data: 'x' }],
    ['revoked proxy', revoked()],
    [
      'throwing data getter',
      {
        get data(): never {
          return boom();
        },
      },
    ],
    [
      'proxy data marker getter',
      { data: new Proxy({}, { get: boom, getPrototypeOf: () => ({}) }) },
    ],
  ])('fails closed on malformed or hostile state (%s)', (_label, state) => {
    const result = prepare(state, validRecord(), NOW_MS);
    expect(result).toEqual({ kind: 'malformed_state' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => prepare(state, validRecord(), NOW_MS)).not.toThrow();
  });

  it('returns unavailable for expired, malformed, or missing drafts and bad clocks', () => {
    const record = validRecord();
    const results = [
      prepare(null, record, NOW_MS - 1),
      prepare(null, record, Date.parse(EXPIRES_ISO)),
      prepare(null, record, Number.NaN),
      prepare(null, record, -1),
      prepare(null, record, 1.5),
      prepare(null, record, Number.MAX_SAFE_INTEGER),
      prepare(null, record, 'now' as unknown as number),
      prepare(null, { ...record, schemaVersion: 2 }, NOW_MS),
      prepare(null, { ...record, createdAt: 'not-a-date' }, NOW_MS),
      prepare(null, {}, NOW_MS),
      prepare(null, null, NOW_MS),
      prepare(null, undefined, NOW_MS),
    ];
    expect(results.map((r) => r.kind)).toEqual(
      Array<string>(results.length).fill('unavailable'),
    );
    expect(Object.isFrozen(results[0])).toBe(true);
  });

  it('gates pending state before the draft and reports unavailable only past the gate', () => {
    const malformed = { schemaVersion: 2 };
    expect(
      prepare(stateWith({ pendingHumanRequest: PENDING }), malformed, NOW_MS),
    ).toEqual({ kind: 'pending_handoff' });
    expect(prepare(null, malformed, NOW_MS)).toEqual({ kind: 'unavailable' });
  });

  it('never mutates its inputs and strips every non-digest secret', () => {
    const raw = {
      ...validRecord(),
      address: SECRET,
      phone: SECRET,
      token: SECRET,
      providerBody: SECRET,
      quoteId: SECRET,
      rateId: SECRET,
      bestRateCents: SECRET,
      providerExpiresAt: SECRET,
    };
    const state = stateWith({ messages: [], address: SECRET, phone: SECRET });
    const before = JSON.stringify({ raw, state });
    const digest = readyDigest(state, raw);
    expect(digest).toEqual(DIGEST);
    expect(JSON.stringify({ raw, state })).toBe(before);
    expect(JSON.stringify(digest)).not.toContain(SECRET);
    expect('address' in digest).toBe(false);
    expect('phone' in digest).toBe(false);
    expect('quoteId' in digest).toBe(false);
    expect('rateId' in digest).toBe(false);
    expect('bestRateCents' in digest).toBe(false);
    expect('providerExpiresAt' in digest).toBe(false);
  });

  it('produces a fresh snapshot immune to post-build source mutation', () => {
    const mutable = JSON.parse(JSON.stringify(validRecord())) as {
      createdAt: string;
      draft: { selectedRate: { carrierName: string } };
    };
    const digest = readyDigest(null, mutable);
    mutable.createdAt = '1999-01-01T00:00:00.000Z';
    mutable.draft.selectedRate.carrierName = 'HACKED';
    expect(digest).toEqual(DIGEST);
  });
});
