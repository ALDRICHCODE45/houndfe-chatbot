import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SHIPPING_APPROVAL_POLICY,
  type ShippingApprovalDecision,
  type ShippingApprovalPinResult,
  type ShippingApprovalPolicy,
} from '../../human-handoff/domain/shipping-approval-policy.port';
import { shippingApprovalPolicyAdapter as adapter } from './shipping-approval-policy.adapter';
import { parseShippingApprovalDecision } from './shipping-approval';
import {
  buildShippingQuoteDraftRecord,
  SHIPPING_QUOTE_DRAFT_KEY as KEY,
} from './shipping-quote-draft-record';

/** SQ-5C2a port + adapter contract; no I/O, Nest, or provider surface. */
const NOW = Date.parse('2026-06-23T12:00:00.000Z');
const CREATED = '2026-06-23T12:00:00.000Z';
const EXPIRES = '2026-06-23T12:30:00.000Z';
const AT_EXPIRY = Date.parse(EXPIRES);
const MISSING = { kind: 'draft_missing' } as const;
const BAD_CLOCK = [
  NaN,
  Infinity,
  -1,
  1.5,
  8.64e15 + 1,
  Number.MAX_SAFE_INTEGER,
  'now',
  null,
  undefined,
];

const REC = buildShippingQuoteDraftRecord(
  {
    quoteId: 'q1',
    selectedRate: {
      rateId: 'r1',
      carrierName: 'Carrier',
      serviceName: 'Service',
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
  },
  NOW,
)!;
const state = () => ({ data: { [KEY]: REC } });

describe('SHIPPING_APPROVAL_POLICY port', () => {
  it('exposes a unique symbol token', () => {
    expect(typeof SHIPPING_APPROVAL_POLICY).toBe('symbol');
    expect(SHIPPING_APPROVAL_POLICY.toString()).toBe(
      'Symbol(SHIPPING_APPROVAL_POLICY)',
    );
    expect(SHIPPING_APPROVAL_POLICY).not.toBe(
      Symbol('SHIPPING_APPROVAL_POLICY'),
    );
  });

  it('compiles the port and decision types against the shipped adapter', () => {
    const approved: ShippingApprovalDecision = {
      decision: 'SHIPPING_APPROVED',
    };
    const rejected: ShippingApprovalDecision = {
      decision: 'SHIPPING_REJECTED',
    };
    const port: ShippingApprovalPolicy = adapter;
    expect(approved.decision).toBe('SHIPPING_APPROVED');
    expect(rejected.decision).toBe('SHIPPING_REJECTED');
    expect(typeof port.parseDecision).toBe('function');
    expect(typeof port.verifyDraftPin).toBe('function');
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.keys(adapter).sort()).toEqual([
      'parseDecision',
      'verifyDraftPin',
    ]);
  });

  it('keeps the domain port free of shipping imports', () => {
    const src = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../human-handoff/domain/shipping-approval-policy.port.ts',
      ),
      'utf8',
    );
    const refs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(refs.filter((ref) => /shipping/i.test(ref))).toEqual([]);
  });
});

describe('shippingApprovalPolicyAdapter', () => {
  it.each<unknown>([
    'APPROVE_SHIPPING',
    'approve_shipping',
    '  Reject_Shipping ',
    'REJECT_SHIPPING',
    'APPROVE_SHIPPING please',
    'yes',
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
  ])('delegates parsing exactly to C1 for %p', (value) => {
    expect(adapter.parseDecision(value)).toBe(
      parseShippingApprovalDecision(value),
    );
  });

  it('returns the canonical frozen decision union shape', () => {
    const approve = adapter.parseDecision('APPROVE_SHIPPING');
    const reject = adapter.parseDecision('REJECT_SHIPPING');
    expect([approve, reject]).toEqual([
      { decision: 'SHIPPING_APPROVED' },
      { decision: 'SHIPPING_REJECTED' },
    ]);
    expect([approve, reject].every((r) => Object.isFrozen(r))).toBe(true);
    expect(approve && Object.keys(approve)).toEqual(['decision']);
  });

  it.each<[string, number, ShippingApprovalPinResult['kind']]>([
    [CREATED, NOW, 'valid'],
    [CREATED, AT_EXPIRY - 1, 'valid'],
    [CREATED, NOW - 1, 'draft_expired'],
    [CREATED, AT_EXPIRY, 'draft_expired'],
    [CREATED, AT_EXPIRY + 1, 'draft_expired'],
    ['2026-06-23T11:59:59.999Z', NOW, 'draft_pin_mismatch'],
    ['2026-06-23T12:00:00Z', NOW, 'draft_pin_mismatch'],
    ['', NOW, 'draft_pin_mismatch'],
    [0 as unknown as string, NOW, 'draft_pin_mismatch'],
    [null as unknown as string, NOW, 'draft_pin_mismatch'],
    [new String(CREATED) as unknown as string, NOW, 'draft_pin_mismatch'],
  ])('verifies pin %p at %p as %p', (pin, now, kind) => {
    const result = adapter.verifyDraftPin(state(), pin, now);
    expect(result).toEqual({ kind });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['kind']);
  });

  it.each(BAD_CLOCK)(
    'fails closed to frozen invalid_clock for %p without reading state',
    (now) => {
      let reads = 0;
      const hostile = {
        get data(): never {
          reads += 1;
          throw new Error('unread');
        },
      };
      const result = adapter.verifyDraftPin(hostile, CREATED, now as number);
      expect(result).toEqual({ kind: 'invalid_clock' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.keys(result)).toEqual(['kind']);
      expect(reads).toBe(0);
    },
  );

  it.each<unknown>([
    null,
    undefined,
    42,
    [],
    {},
    { data: null },
    { data: {} },
    { data: { [KEY]: null } },
    { data: { [KEY]: {} } },
    { data: { [KEY]: { ...REC, schemaVersion: 2 } } },
    { data: { [KEY]: { ...REC, createdAt: 'not-a-date' } } },
  ])('fails closed to frozen draft_missing for %p', (value) => {
    const result = adapter.verifyDraftPin(value, CREATED, NOW);
    expect(result).toEqual(MISSING);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['kind']);
  });

  it('fails closed for hostile getters/proxies without a second read', () => {
    let reads = 0;
    const stateful = {
      get data(): unknown {
        reads += 1;
        return reads === 1 ? null : state().data;
      },
    };
    const throwing = {
      get data(): never {
        throw new Error('hostile');
      },
    };
    const badKey = {
      data: {
        get [KEY](): never {
          throw new Error('hostile');
        },
      },
    };
    const { proxy, revoke } = Proxy.revocable(state(), {});
    revoke();
    const results = [stateful, throwing, badKey, proxy].map((value) =>
      adapter.verifyDraftPin(value, CREATED, NOW),
    );
    expect(results).toEqual([MISSING, MISSING, MISSING, MISSING]);
    expect(reads).toBe(1);
    expect(() => adapter.verifyDraftPin(throwing, CREATED, NOW)).not.toThrow();
  });

  it('retains no source reference and performs no network access', () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    const mutable = JSON.parse(JSON.stringify(state())) as {
      data: Record<
        string,
        { createdAt: string; draft: { carrierName: string } }
      >;
    };
    const before = adapter.verifyDraftPin(mutable, CREATED, NOW);
    mutable.data[KEY].createdAt = '2026-06-23T12:00:00.001Z';
    mutable.data[KEY].draft.carrierName = 'HACKED';
    expect(before).toEqual({ kind: 'valid' });
    expect(adapter.verifyDraftPin(mutable, CREATED, NOW)).toEqual({
      kind: 'draft_pin_mismatch',
    });
    adapter.parseDecision('APPROVE_SHIPPING');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
