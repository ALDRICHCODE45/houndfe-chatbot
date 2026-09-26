import {
  buildShippingApprovalDigest as build,
  parseShippingApprovalDecision as parse,
  type ShippingApprovalDecision,
} from './shipping-approval';
import { buildShippingQuoteDraftRecord } from './shipping-quote-draft-record';
import type { ShippingQuoteDraft } from './shipping-quote-draft';

/**
 * Contract tests for the pure SQ-5C1 shipping-approval boundary.
 *
 * Spec: human-handoff §"shipping_approval request" — one redacted ops
 * digest built from an unexpired internal draft, plus one strict
 * approve/reject parser. No I/O, provider, or customer surface.
 */
const NOW_MS = Date.parse('2026-06-23T12:00:00.000Z');
const CREATED_ISO = '2026-06-23T12:00:00.000Z';
const EXPIRES_ISO = '2026-06-23T12:30:00.000Z';
const SECRET = 'svc_secret_token';
const SEVEN_KEYS = [
  'carrierName',
  'customerPaysCents',
  'draftCreatedAt',
  'estimatedDeliveryDays',
  'kind',
  'serviceName',
  'totalCreditCents',
];

const EXPECTED = {
  kind: 'shipping_approval',
  draftCreatedAt: CREATED_ISO,
  customerPaysCents: 6_900,
  totalCreditCents: 12_000,
  carrierName: 'Skydropx Express',
  serviceName: 'DHL Express',
  estimatedDeliveryDays: 3,
} as const;

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

describe('buildShippingApprovalDigest', () => {
  it('builds the exact frozen seven-field digest at the created boundary', () => {
    const digest = build(validRecord(), NOW_MS)!;
    expect(digest).toEqual(EXPECTED);
    expect(Object.keys(digest).sort()).toEqual(SEVEN_KEYS);
    expect(Object.isFrozen(digest)).toBe(true);
  });

  it('fails closed before creation and at exact expiry, and passes just before expiry', () => {
    const record = validRecord();
    expect(build(record, NOW_MS - 1)).toBeNull();
    expect(build(record, Date.parse(EXPIRES_ISO))).toBeNull();
    expect(build(record, Date.parse(EXPIRES_ISO) - 1)).toEqual(EXPECTED);
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    8.64e15 + 1,
    Number.MAX_SAFE_INTEGER,
    'now',
    null,
    undefined,
    {},
    true,
  ])('fails closed for invalid clock %p', (now) => {
    expect(build(validRecord(), now as number)).toBeNull();
  });

  it('fails closed without throwing on malformed records, hostile getters, and revoked proxies', () => {
    const valid = validRecord();
    const hostile = {
      get schemaVersion(): never {
        throw new Error('hostile getter');
      },
    };
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const results = [
      build(null, NOW_MS),
      build(undefined, NOW_MS),
      build(42, NOW_MS),
      build('x', NOW_MS),
      build([], NOW_MS),
      build({}, NOW_MS),
      build({ ...valid, schemaVersion: 2 }, NOW_MS),
      build(
        { ...valid, createdAt: 'not-a-date', expiresAt: EXPIRES_ISO },
        NOW_MS,
      ),
      build(hostile, NOW_MS),
      build(proxy, NOW_MS),
    ];
    expect(results).toEqual(Array<null>(results.length).fill(null));
    expect(() => build(hostile, NOW_MS)).not.toThrow();
  });

  it('never serializes extra address, phone, product, provider, secret, raw, quote, rate, gross, or expiry fields', () => {
    const raw = {
      ...validRecord(),
      address: SECRET,
      phone: SECRET,
      productId: SECRET,
      providerBody: SECRET,
      token: SECRET,
      rawError: SECRET,
      quoteId: SECRET,
      rateId: SECRET,
      grossCents: SECRET,
      bestRateCents: SECRET,
      appliedCreditCents: SECRET,
      unusedCreditCents: SECRET,
      qualifyingUnitCount: SECRET,
      providerExpiresAt: SECRET,
      validUntil: SECRET,
    };
    const digest = build(raw, NOW_MS)!;
    expect(digest).toEqual(EXPECTED);
    expect(Object.keys(digest).sort()).toEqual(SEVEN_KEYS);
    expect(JSON.stringify(digest)).not.toContain(SECRET);
    expect('expiresAt' in digest).toBe(false);
    expect('providerExpiresAt' in digest).toBe(false);
    expect('quoteId' in digest).toBe(false);
    expect('rateId' in digest).toBe(false);
    expect('bestRateCents' in digest).toBe(false);
  });

  it('is not altered by source mutation after build', () => {
    const mutable = JSON.parse(JSON.stringify(validRecord())) as {
      createdAt: string;
      draft: {
        customerPaysCents: number;
        selectedRate: { carrierName: string };
      };
    };
    const digest = build(mutable, NOW_MS)!;
    mutable.createdAt = '1999-01-01T00:00:00.000Z';
    mutable.draft.customerPaysCents = 1;
    mutable.draft.selectedRate.carrierName = 'HACKED';
    expect(digest).toEqual(EXPECTED);
  });
});

describe('parseShippingApprovalDecision', () => {
  it.each<[string, ShippingApprovalDecision]>([
    ['APPROVE_SHIPPING', { decision: 'SHIPPING_APPROVED' }],
    ['approve_shipping', { decision: 'SHIPPING_APPROVED' }],
    ['Approve_Shipping', { decision: 'SHIPPING_APPROVED' }],
    ['  APPROVE_SHIPPING  ', { decision: 'SHIPPING_APPROVED' }],
    ['\n\tAPPROVE_SHIPPING\r\n', { decision: 'SHIPPING_APPROVED' }],
    ['REJECT_SHIPPING', { decision: 'SHIPPING_REJECTED' }],
    ['reject_shipping', { decision: 'SHIPPING_REJECTED' }],
    ['  Reject_Shipping ', { decision: 'SHIPPING_REJECTED' }],
  ])('parses exact keyword %p', (value, expected) => {
    const result = parse(value)!;
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['decision']);
  });

  it.each<unknown>([
    'APPROVE_SHIPPING please',
    'APPROVE_SHIPPING: yes',
    'HF-abc123: APPROVE_SHIPPING',
    'APPROVE_SHIPPING_EXTRA',
    'prefix APPROVE_SHIPPING',
    'APPROVED_SHIPPING',
    'REJECTED_SHIPPING',
    'APPROVE_SHIPPING REJECT_SHIPPING',
    'yes',
    'aprobar',
    '',
    '   ',
    42,
    0,
    null,
    undefined,
    true,
    ['APPROVE_SHIPPING'],
    new String('APPROVE_SHIPPING'),
    { toString: () => 'APPROVE_SHIPPING' },
  ])('rejects non-exact value %p', (value) => {
    expect(parse(value)).toBeNull();
  });

  it('exposes the exported decision type and never throws on hostile input', () => {
    const typed: ShippingApprovalDecision | null = parse('APPROVE_SHIPPING');
    expect(typed).toEqual({ decision: 'SHIPPING_APPROVED' });
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile value');
        },
      },
    );
    expect(() => parse(hostile)).not.toThrow();
  });
});
