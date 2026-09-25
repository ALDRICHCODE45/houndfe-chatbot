import {
  RESTOCK_MAX_PRODUCT_NAME_LENGTH,
  normalizeRestockDecision,
  normalizeRestockIntake,
  normalizeRestockIntakeReceipt,
} from './human-decisions.dto';
import type { RestockIntakeInput } from './human-decisions.dto';

type Rec = Record<string, unknown>;

const U = {
  source: '11111111-1111-4111-8111-111111111111',
  product: '22222222-2222-4222-8222-222222222222',
  variant: '33333333-3333-4333-8333-333333333333',
  supersedes: '44444444-4444-4444-8444-444444444444',
};

const omitted = (obj: Rec, key: string): Rec => {
  const copy = { ...obj };
  delete copy[key];
  return copy;
};

const intake = (extra: Rec = {}): Rec => ({
  sourceRequestId: U.source,
  type: 'RESTOCK',
  productId: U.product,
  productName: 'Croquetas Premium',
  ...extra,
});

const defined = (obj: Rec, key: string, value: unknown): Rec =>
  Object.defineProperty({ ...obj }, key, { value });
const accessor = (obj: Rec, key: string): Rec =>
  Object.defineProperty({ ...obj }, key, { get: () => 'x', enumerable: true });
const boom = (): never => {
  throw new Error('boom');
};
const throwingProxy = (target: Rec, trap: 'get' | 'ownKeys'): object =>
  new Proxy(target, { [trap]: boom });

class IntakeClass {
  sourceRequestId = U.source;
  type = 'RESTOCK';
  productId = U.product;
  productName = 'Croquetas Premium';
}

describe('normalizeRestockIntake', () => {
  it('fills every omitted nullable field with null', () => {
    expect(normalizeRestockIntake(intake())).toEqual({
      ...intake(),
      variantId: null,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: null,
      stockObservedAt: null,
      supersedesDecisionId: null,
    });
  });

  it('treats explicit null like omitted nullable fields', () => {
    const allNull = intake({
      variantId: null,
      sku: null,
      requestedQuantity: null,
      observedStockAtRequest: null,
      stockObservedAt: null,
      supersedesDecisionId: null,
    });
    expect(normalizeRestockIntake(allNull)).toEqual(
      normalizeRestockIntake(intake()),
    );
  });

  it('canonicalizes a fully populated intake', () => {
    expect(
      normalizeRestockIntake(
        intake({
          variantId: U.variant,
          sku: '  SKU-9  ',
          requestedQuantity: 3,
          observedStockAtRequest: 0,
          stockObservedAt: '2026-06-22T10:30:00+02:00',
          supersedesDecisionId: U.supersedes,
        }),
      ),
    ).toEqual({
      sourceRequestId: U.source,
      type: 'RESTOCK',
      productId: U.product,
      productName: 'Croquetas Premium',
      variantId: U.variant,
      sku: 'SKU-9',
      requestedQuantity: 3,
      observedStockAtRequest: 0,
      stockObservedAt: '2026-06-22T08:30:00.000Z',
      supersedesDecisionId: U.supersedes,
    });
  });

  it('collapses productName whitespace', () => {
    const input = intake({ productName: '  Croquetas   Premium  ' });
    expect(normalizeRestockIntake(input)?.productName).toBe(
      'Croquetas Premium',
    );
  });

  it('normalizes sku and productName to NFC', () => {
    const n = normalizeRestockIntake(
      intake({ sku: 'Cafe\u0301', productName: 'Cafe\u0301' }),
    );
    expect([n?.sku, n?.productName]).toEqual(['Caf\u00e9', 'Caf\u00e9']);
  });

  it('normalizes a blank sku to null', () => {
    expect(normalizeRestockIntake(intake({ sku: '   ' }))?.sku).toBeNull();
  });

  it('accepts a productName at the bound and rejects one over it', () => {
    const at = 'a'.repeat(RESTOCK_MAX_PRODUCT_NAME_LENGTH);
    expect(
      normalizeRestockIntake(intake({ productName: at }))?.productName,
    ).toBe(at);
    expect(
      normalizeRestockIntake(intake({ productName: at + 'a' })),
    ).toBeNull();
  });

  const bad: Array<[string, unknown]> = [
    ['non-uuid sourceRequestId', intake({ sourceRequestId: 'x' })],
    ['missing sourceRequestId', omitted(intake(), 'sourceRequestId')],
    ['non-uuid productId', intake({ productId: 42 })],
    ['missing productId', omitted(intake(), 'productId')],
    ['wrong type', intake({ type: 'SHIPPING' })],
    ['missing type', omitted(intake(), 'type')],
    ['non-string productName', intake({ productName: 7 })],
    ['empty productName', intake({ productName: '' })],
    ['whitespace productName', intake({ productName: ' \t ' })],
    ['productName C0 control', intake({ productName: 'a\u001f' })],
    ['productName C1 control', intake({ productName: '\u007fb' })],
    ['productName edge tab', intake({ productName: 'Croquetas\t' })],
    ['non-uuid variantId', intake({ variantId: 'nope' })],
    ['non-string sku', intake({ sku: 5 })],
    ['sku C0 control', intake({ sku: 'a\u0000' })],
    ['sku C1 control', intake({ sku: '\u009fb' })],
    ['sku edge tab', intake({ sku: '\tSKU-9' })],
    ['zero requestedQuantity', intake({ requestedQuantity: 0 })],
    ['negative requestedQuantity', intake({ requestedQuantity: -1 })],
    ['fractional requestedQuantity', intake({ requestedQuantity: 2.5 })],
    ['string requestedQuantity', intake({ requestedQuantity: '2' })],
    ['negative stock tick', intake({ observedStockAtRequest: -1 })],
    ['fractional stock tick', intake({ observedStockAtRequest: 1.5 })],
    ['non-string stockObservedAt', intake({ stockObservedAt: 1719000000 })],
    ['unparseable instant', intake({ stockObservedAt: 'nope' })],
    ['malformed instant', intake({ stockObservedAt: '2026-13-40T99:99:99Z' })],
    ['date-only instant', intake({ stockObservedAt: '2026-06-22' })],
    ['tick without instant', intake({ observedStockAtRequest: 5 })],
    [
      'instant without tick',
      intake({ stockObservedAt: '2026-06-22T10:30:00Z' }),
    ],
    ['non-uuid supersedesDecisionId', intake({ supersedesDecisionId: 'x' })],
    ['extra tenantId', intake({ tenantId: U.source })],
    ['extra source', intake({ source: 'houndfe-chatbot' })],
    ['extra branchId', intake({ branchId: U.source })],
    ['extra credentialId', intake({ credentialId: U.source })],
    [
      'impossible Feb 30 offset',
      intake({
        observedStockAtRequest: 1,
        stockObservedAt: '2026-02-30T10:00:00+02:00',
      }),
    ],
    [
      'impossible Apr 31 offset',
      intake({
        observedStockAtRequest: 1,
        stockObservedAt: '2026-04-31T10:00:00-05:00',
      }),
    ],
    [
      'unsafe integer quantity',
      intake({ requestedQuantity: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      'unsafe integer stock tick',
      intake({
        observedStockAtRequest: 2 ** 60,
        stockObservedAt: '2026-06-22T10:30:00Z',
      }),
    ],
    ['symbol extra key', { ...intake(), [Symbol('tenantId')]: 1 }],
    ['non-enumerable extra key', defined(intake(), 'tenantId', 'x')],
    ['accessor property', accessor(intake(), 'sku')],
    ['class instance', new IntakeClass()],
    ['inherited object', Object.create(intake())],
    ['own __proto__ object', defined(intake(), '__proto__', { x: 1 })],
    ['own __proto__ primitive', defined(intake(), '__proto__', 1)],
    ['null input', null],
    ['string input', 'nope'],
    ['array input', []],
  ];

  it.each(bad)('rejects %s', (_label, input) => {
    expect(normalizeRestockIntake(input)).toBeNull();
  });

  it('fails closed on hostile getters and proxies', () => {
    const getter = intake();
    Object.defineProperty(getter, 'productName', {
      enumerable: true,
      get: boom,
    });
    expect(normalizeRestockIntake(getter)).toBeNull();
    const spoof = new Proxy(intake(), {
      get: (t, k) => (k === 'productId' ? U.variant : t[String(k)]),
    });
    expect(normalizeRestockIntake(spoof)).toBeNull();
    expect(normalizeRestockIntake(throwingProxy({}, 'ownKeys'))).toBeNull();
    expect(normalizeRestockIntake(throwingProxy(intake(), 'get'))).toBeNull();
  });
});

const RECEIPT_ID = '55555555-5555-4555-8555-555555555555';
const BRANCH_ID = '66666666-6666-4666-8666-666666666666';
const CREATED_AT = '2026-06-22T10:30:00.000Z';
const OFFSET_ISO = '2026-06-22T12:30:00+02:00';
const OTHER_ISO = '2026-06-22T09:30:00Z';
const BAD_ISO = '2026-02-30T10:00:00Z';
const HEX_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const sentIntake = (): RestockIntakeInput =>
  normalizeRestockIntake(
    intake({
      variantId: U.variant,
      sku: 'SKU-9',
      requestedQuantity: 3,
      observedStockAtRequest: 4,
      stockObservedAt: '2026-06-22T10:30:00+02:00',
      supersedesDecisionId: U.supersedes,
    }),
  ) as RestockIntakeInput;
const sentMinimal = (): RestockIntakeInput =>
  normalizeRestockIntake(intake()) as RestockIntakeInput;
const receiptFor = (
  sent: RestockIntakeInput,
  extra: Rec = {},
  snap: Rec = {},
): Rec => ({
  id: RECEIPT_ID,
  sourceRequestId: sent.sourceRequestId,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: CREATED_AT,
  snapshot: {
    branchId: BRANCH_ID,
    branchName: 'Sucursal Centro',
    productId: sent.productId,
    productName: sent.productName,
    variantId: sent.variantId,
    sku: sent.sku,
    requestedQuantity: sent.requestedQuantity,
    observedStockAtRequest: sent.observedStockAtRequest,
    stockObservedAt: sent.stockObservedAt,
    ...snap,
  },
  supersedesDecisionId: sent.supersedesDecisionId,
  resolution: null,
  applyBefore: null,
  ...extra,
});
class ReceiptClass {
  id = RECEIPT_ID;
}
const norm = (value: unknown, sent: RestockIntakeInput) =>
  normalizeRestockIntakeReceipt(value, sent);
const snapAccessor = (s: RestockIntakeInput): Rec => ({
  ...receiptFor(s),
  snapshot: accessor(receiptFor(s).snapshot as Rec, 'branchName'),
});

describe('normalizeRestockIntakeReceipt', () => {
  it('normalizes a fully populated historical POST receipt', () => {
    const sent = sentIntake();
    expect(norm(receiptFor(sent), sent)).toEqual(receiptFor(sent));
  });

  it('normalizes a sparse receipt and canonicalizes instants', () => {
    const sent = sentMinimal();
    const receipt = receiptFor(sent, { createdAt: OFFSET_ISO });
    expect(norm(receipt, sent)).toMatchObject({
      createdAt: '2026-06-22T10:30:00.000Z',
      snapshot: {
        branchName: 'Sucursal Centro',
        variantId: null,
        sku: null,
        requestedQuantity: null,
        observedStockAtRequest: null,
        stockObservedAt: null,
      },
      supersedesDecisionId: null,
      status: 'PENDING',
      version: 1,
      resolution: null,
      applyBefore: null,
    });
  });

  it('keeps the historical PENDING/v1 outcome for a post-RESOLVED replay', () => {
    const sent = sentMinimal();
    const result = norm(receiptFor(sent), sent);
    expect([
      result?.status,
      result?.version,
      result?.resolution,
      result?.applyBefore,
    ]).toEqual(['PENDING', 1, null, null]);
  });

  it('accepts a case-insensitive UUID identity and a null branchName', () => {
    const sent = sentMinimal();
    const upper = receiptFor(sent, { sourceRequestId: U.source.toUpperCase() });
    expect(norm(upper, sent)?.sourceRequestId).toBe(sent.sourceRequestId);
    const noBranch = receiptFor(sent, {}, { branchName: null });
    expect(norm(noBranch, sent)?.snapshot.branchName).toBeNull();
  });

  it('requires every declared receipt and snapshot key', () => {
    const sent = sentMinimal();
    const base = receiptFor(sent);
    const snap = base.snapshot as Rec;
    for (const k of Object.keys(base)) {
      expect(norm(omitted(base, k), sent)).toBeNull();
    }
    for (const k of Object.keys(snap)) {
      expect(norm({ ...base, snapshot: omitted(snap, k) }, sent)).toBeNull();
    }
  });

  it('preserves an exact blank or padded branchName', () => {
    const sent = sentMinimal();
    for (const name of ['   ', '  Centro  ']) {
      const out = norm(receiptFor(sent, {}, { branchName: name }), sent);
      expect(out?.snapshot.branchName).toBe(name);
    }
  });

  it('returns the backend UUID case instead of rehydrating sent', () => {
    const upper = HEX_ID.toUpperCase();
    const sent = { ...sentMinimal(), sourceRequestId: HEX_ID };
    const out = norm(receiptFor(sent, { sourceRequestId: upper }), sent);
    expect(out?.sourceRequestId).toBe(upper);
  });

  const bound: Array<[string, (s: RestockIntakeInput) => Rec]> = [
    ['sourceRequestId', (s) => receiptFor(s, { sourceRequestId: U.variant })],
    ['type', (s) => receiptFor(s, { type: 'SHIPPING' })],
    ['productId', (s) => receiptFor(s, {}, { productId: U.variant })],
    ['productName', (s) => receiptFor(s, {}, { productName: 'Otra' })],
    ['variantId', (s) => receiptFor(s, {}, { variantId: null })],
    ['sku', (s) => receiptFor(s, {}, { sku: 'OTRO' })],
    ['sku padding', (s) => receiptFor(s, {}, { sku: '  SKU-9  ' })],
    ['reqQuantity', (s) => receiptFor(s, {}, { requestedQuantity: 4 })],
    ['observedStock', (s) => receiptFor(s, {}, { observedStockAtRequest: 5 })],
    ['observedAt', (s) => receiptFor(s, {}, { stockObservedAt: OTHER_ISO })],
    ['supersedes', (s) => receiptFor(s, { supersedesDecisionId: null })],
  ];

  it.each(bound)('rejects %s not bound to sent', (_label, build) => {
    const sent = sentIntake();
    expect(norm(build(sent), sent)).toBeNull();
  });

  it('rejects receipts that add subject fields absent from sent', () => {
    const sent = sentMinimal();
    for (const snap of [{ variantId: U.variant }, { sku: 'SKU-9' }]) {
      expect(norm(receiptFor(sent, {}, snap), sent)).toBeNull();
    }
    const extra = receiptFor(sent, { supersedesDecisionId: U.supersedes });
    expect(norm(extra, sent)).toBeNull();
  });

  const state: Array<[string, (s: RestockIntakeInput) => Rec]> = [
    ['status', (s) => receiptFor(s, { status: 'RESOLVED' })],
    ['version 2', (s) => receiptFor(s, { version: 2 })],
    ['version 0', (s) => receiptFor(s, { version: 0 })],
    ['resolution', (s) => receiptFor(s, { resolution: {} })],
    ['applyBefore', (s) => receiptFor(s, { applyBefore: CREATED_AT })],
    ['missing status', (s) => omitted(receiptFor(s), 'status')],
    ['missing version', (s) => omitted(receiptFor(s), 'version')],
    ['missing resolution', (s) => omitted(receiptFor(s), 'resolution')],
    ['missing applyBefore', (s) => omitted(receiptFor(s), 'applyBefore')],
  ];

  it.each(state)('rejects a non-historical state (%s)', (_label, build) => {
    const sent = sentMinimal();
    expect(norm(build(sent), sent)).toBeNull();
  });

  const shape: Array<[string, (s: RestockIntakeInput) => unknown]> = [
    ['top extra', (s) => receiptFor(s, { tenantId: U.source })],
    ['top branchName', (s) => receiptFor(s, { branchName: 'x' })],
    ['snap extra', (s) => receiptFor(s, {}, { tenantId: U.source })],
    ['snap branchLabel', (s) => receiptFor(s, {}, { branchLabel: 'x' })],
    ['missing id', (s) => omitted(receiptFor(s), 'id')],
    ['non-uuid id', (s) => receiptFor(s, { id: 'x' })],
    ['non-uuid branchId', (s) => receiptFor(s, {}, { branchId: 'x' })],
    ['numeric branchName', (s) => receiptFor(s, {}, { branchName: 7 })],
    ['branchName control', (s) => receiptFor(s, {}, { branchName: 'a\u0000' })],
    ['impossible createdAt', (s) => receiptFor(s, { createdAt: BAD_ISO })],
    ['date-only createdAt', (s) => receiptFor(s, { createdAt: '2026-06-22' })],
    ['numeric createdAt', (s) => receiptFor(s, { createdAt: 1719000000 })],
    ['missing snapshot', (s) => omitted(receiptFor(s), 'snapshot')],
    ['array snapshot', (s) => receiptFor(s, { snapshot: [] })],
    ['symbol key', (s) => ({ ...receiptFor(s), [Symbol('tenantId')]: 1 })],
    ['non-enumerable key', (s) => defined(receiptFor(s), 'tenantId', 'x')],
    ['accessor createdAt', (s) => accessor(receiptFor(s), 'createdAt')],
    ['accessor branchName', (s) => snapAccessor(s)],
    ['class instance', () => new ReceiptClass()],
    ['inherited object', (s) => Object.create(receiptFor(s)) as unknown],
    ['super undef', (s) => receiptFor(s, { supersedesDecisionId: undefined })],
    ['snapshot sku undef', (s) => receiptFor(s, {}, { sku: undefined })],
    ['null input', () => null],
    ['string input', () => 'nope'],
    ['array input', () => []],
  ];

  it.each(shape)('rejects a malformed receipt (%s)', (_label, build) => {
    const sent = sentMinimal();
    expect(norm(build(sent), sent)).toBeNull();
  });

  it('fails closed on hostile getters, proxies and a missing sent intake', () => {
    const sent = sentIntake();
    const getter = receiptFor(sent);
    Object.defineProperty(getter, 'createdAt', { enumerable: true, get: boom });
    expect(norm(getter, sent)).toBeNull();
    const spoof = new Proxy(receiptFor(sent), {
      get: (t, k) => (k === 'id' ? U.variant : t[String(k)]),
    });
    expect(norm(spoof, sent)).toBeNull();
    expect(norm(throwingProxy({}, 'ownKeys'), sent)).toBeNull();
    expect(norm(throwingProxy(receiptFor(sent), 'get'), sent)).toBeNull();
    expect(norm(receiptFor(sent), null as never)).toBeNull();
  });
});

const RESOLVED_AT = '2026-06-22T10:30:00.000Z';
const APPLY_BEFORE = '2026-06-22T11:30:00.000Z';
const plus = (ms: number): string =>
  new Date(Date.parse(RESOLVED_AT) + ms).toISOString();

const snapBase = (): Rec => receiptFor(sentIntake()).snapshot as Rec;
const positive = (extra: Rec = {}): Rec => ({
  action: 'PROVIDE_RESTOCK_ESTIMATE',
  restockDays: 5,
  resolvedAt: RESOLVED_AT,
  ...extra,
});
const negative = (extra: Rec = {}): Rec => ({
  action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
  resolvedAt: RESOLVED_AT,
  ...extra,
});
const pending = (extra: Rec = {}, snap: Rec = {}): Rec => ({
  id: RECEIPT_ID,
  sourceRequestId: U.source,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: CREATED_AT,
  snapshot: { ...snapBase(), ...snap },
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
  ...extra,
});
const resolved = (resolution: Rec, extra: Rec = {}): Rec =>
  pending({
    status: 'RESOLVED',
    version: 2,
    resolution,
    applyBefore: APPLY_BEFORE,
    ...extra,
  });
const dnorm = (value: unknown) => normalizeRestockDecision(value);

describe('normalizeRestockDecision', () => {
  it('normalizes PENDING v1 and both RESOLVED v2 variants', () => {
    expect(dnorm(pending())).toEqual(pending());
    expect(dnorm(resolved(positive()))).toEqual(resolved(positive()));
    const negativeOut = dnorm(resolved(negative()));
    expect(negativeOut).toEqual(resolved(negative()));
    expect(Object.keys(negativeOut?.resolution ?? {})).toEqual([
      'action',
      'resolvedAt',
    ]);
  });

  it('accepts bounds, offset canonicalization and the +1h window', () => {
    expect(dnorm(resolved(positive({ restockDays: 1 })))).not.toBeNull();
    expect(dnorm(resolved(positive({ restockDays: 365 })))).not.toBeNull();
    expect(
      dnorm(
        resolved(positive({ resolvedAt: '2026-06-22T12:30:00+02:00' }), {
          createdAt: '2026-06-22T10:30:00Z',
        }),
      ),
    ).toMatchObject({
      createdAt: RESOLVED_AT,
      resolution: { resolvedAt: RESOLVED_AT },
      applyBefore: APPLY_BEFORE,
    });
    expect(
      dnorm(
        resolved(positive({ resolvedAt: '2026-06-22T10:30:00Z' }), {
          applyBefore: '2026-06-22T12:30:00+01:00',
        }),
      )?.applyBefore,
    ).toBe(APPLY_BEFORE);
  });

  it('preserves exact backend product/branch/sku bytes', () => {
    const snap = {
      branchName: '  Centro  ',
      sku: '  SKU-9  ',
      productName: 'Croquetas  Premium',
    };
    const out = dnorm(pending({}, snap));
    expect([out?.snapshot.branchName, out?.snapshot.sku]).toEqual([
      snap.branchName,
      snap.sku,
    ]);
    expect(out?.snapshot.productName).toBe(snap.productName);
  });

  it('requires every declared top-level and snapshot key', () => {
    const base = pending();
    const snap = base.snapshot as Rec;
    for (const key of Object.keys(base)) {
      expect(dnorm(omitted(base, key))).toBeNull();
    }
    for (const key of Object.keys(snap)) {
      expect(dnorm({ ...base, snapshot: omitted(snap, key) })).toBeNull();
    }
  });

  it('requires the exact resolution key set', () => {
    for (const bad of [
      omitted(positive(), 'resolvedAt'),
      positive({ resolvedBy: { id: U.supersedes } }),
      omitted(positive(), 'restockDays'),
      omitted(negative(), 'resolvedAt'),
      negative({ restockDays: 5 }),
      negative({ evidenceCode: 'X' }),
    ]) {
      expect(dnorm(resolved(bad))).toBeNull();
    }
  });

  const snapAccessor = {
    ...pending(),
    snapshot: accessor(snapBase(), 'productName'),
  };
  const days = (n: unknown): Rec => resolved(positive({ restockDays: n }));
  const at = (instant: unknown): Rec =>
    resolved(positive(), { applyBefore: instant });
  const bad: Array<[string, unknown]> = [
    ['RESOLVED with version 1', resolved(positive(), { version: 1 })],
    ['PENDING with version 2', pending({ version: 2 })],
    ['PENDING with resolution', pending({ resolution: positive() })],
    ['PENDING with applyBefore', pending({ applyBefore: APPLY_BEFORE })],
    ['RESOLVED with null resolution', resolved(null as never)],
    ['RESOLVED with null applyBefore', at(null)],
    ['unknown status', pending({ status: 'EXPIRED' })],
    ['version 0', pending({ version: 0 })],
    ['RESOLVED version 3', resolved(positive(), { version: 3 })],
    ['restockDays zero', days(0)],
    ['restockDays 366', days(366)],
    ['restockDays fraction', days(2.5)],
    ['restockDays string', days('5')],
    ['restockDays negative', days(-1)],
    ['restockDays missing', resolved(omitted(positive(), 'restockDays'))],
    ['restockDays undefined', days(undefined)],
    ['impossible resolvedAt', resolved(positive({ resolvedAt: BAD_ISO }))],
    ['date-only resolvedAt', resolved(positive({ resolvedAt: '2026-06-22' }))],
    ['numeric resolvedAt', resolved(positive({ resolvedAt: 1719000000 }))],
    ['impossible applyBefore', at(BAD_ISO)],
    ['date-only applyBefore', at('2026-06-22')],
    ['zero window', at(RESOLVED_AT)],
    ['short window', at(plus(3_599_999))],
    ['long window', at(plus(3_600_001))],
    ['wrong hour', at(OTHER_ISO)],
    ['top extra', pending({ tenantId: U.source })],
    ['top evidenceCode', pending({ evidenceCode: 'X' })],
    ['snapshot extra', pending({}, { branchLabel: 'x' })],
    ['non-uuid id', pending({ id: 'x' })],
    ['non-uuid sourceRequestId', pending({ sourceRequestId: 'x' })],
    ['non-uuid branchId', pending({}, { branchId: 'x' })],
    ['non-uuid productId', pending({}, { productId: 'x' })],
    ['wrong type', pending({ type: 'SHIPPING' })],
    ['numeric productName', pending({}, { productName: 7 })],
    ['blank productName', pending({}, { productName: '  ' })],
    ['overlong productName', pending({}, { productName: 'a'.repeat(201) })],
    ['string requestedQuantity', pending({}, { requestedQuantity: '3' })],
    ['zero requestedQuantity', pending({}, { requestedQuantity: 0 })],
    ['negative observedStock', pending({}, { observedStockAtRequest: -1 })],
    ['symbol key', { ...pending(), [Symbol('tenantId')]: 1 }],
    ['non-enumerable key', defined(pending(), 'tenantId', 'x')],
    ['accessor top', accessor(pending(), 'createdAt')],
    ['accessor resolution', resolved(accessor(positive(), 'restockDays'))],
    ['accessor snapshot', snapAccessor],
    ['class instance', new ReceiptClass()],
    ['inherited object', Object.create(pending())],
    ['null input', null],
    ['string input', 'nope'],
    ['array input', []],
  ];

  it.each(bad)('rejects a malformed decision (%s)', (_l, value) => {
    expect(dnorm(value)).toBeNull();
  });

  it('rejects a missing nullable key but accepts an explicit null', () => {
    expect(dnorm(pending({ supersedesDecisionId: null }))).not.toBeNull();
    expect(dnorm(omitted(pending(), 'supersedesDecisionId'))).toBeNull();
    expect(dnorm(pending({}, { variantId: null, sku: null }))).not.toBeNull();
    expect(dnorm(pending({}, { sku: undefined }))).toBeNull();
    expect(dnorm({ ...pending(), supersedesDecisionId: undefined })).toBeNull();
  });

  it('requires the stock pair to be both null or both set', () => {
    const bothNull = pending(
      {},
      { observedStockAtRequest: null, stockObservedAt: null },
    );
    expect(dnorm(bothNull)).not.toBeNull();
    expect(dnorm(pending({}, { observedStockAtRequest: null }))).toBeNull();
    expect(dnorm(pending({}, { stockObservedAt: null }))).toBeNull();
  });

  it('fails closed on hostile getters and proxies', () => {
    const getter = pending();
    Object.defineProperty(getter, 'createdAt', { enumerable: true, get: boom });
    expect(dnorm(getter)).toBeNull();
    const spoof = new Proxy(pending(), {
      get: (t, k) => (k === 'id' ? U.variant : t[String(k)]),
    });
    expect(dnorm(spoof)).toBeNull();
    expect(dnorm(throwingProxy({}, 'ownKeys'))).toBeNull();
    expect(dnorm(throwingProxy(pending(), 'get'))).toBeNull();
  });
});
