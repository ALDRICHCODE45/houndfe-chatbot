import {
  normalizeExpirationIntake,
  type ExpirationIntakeInput,
} from './human-decisions-expiration.dto';
import { normalizeExpirationIntakeReceipt } from './human-decisions-expiration-receipt.dto';

type Rec = Record<string, unknown>;

const U = {
  source: '11111111-1111-4111-8111-111111111111',
  product: '22222222-2222-4222-8222-222222222222',
  variant: '33333333-3333-4333-8333-333333333333',
};
const A_SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const A_PRODUCT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const A_VARIANT = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
const CREATED_AT = '2026-06-22T10:30:00.000Z';

const omit = (o: Rec, k: string): Rec => {
  const c = { ...o };
  delete c[k];
  return c;
};
const boom = (): never => {
  throw new Error('boom');
};
const proxy = (t: Rec, trap: 'get' | 'ownKeys'): object =>
  new Proxy(t, { [trap]: boom });

const sentOf = (extra: Rec = {}): ExpirationIntakeInput =>
  normalizeExpirationIntake({
    sourceRequestId: U.source,
    type: 'EXPIRATION',
    productId: U.product,
    variantId: null,
    ...extra,
  }) as ExpirationIntakeInput;
const variantSent = (): ExpirationIntakeInput =>
  sentOf({ variantId: U.variant });
const receiptFor = (
  sent: ExpirationIntakeInput,
  extra: Rec = {},
  snap: Rec = {},
): Rec => ({
  id: '55555555-5555-4555-8555-555555555555',
  sourceRequestId: sent.sourceRequestId,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: CREATED_AT,
  snapshot: {
    branchId: '66666666-6666-4666-8666-666666666666',
    branchName: 'Sucursal Centro',
    productId: sent.productId,
    productName: 'Croquetas Premium',
    unit: 'PZA',
    variantId: sent.variantId,
    variantName: sent.variantId === null ? null : 'Senior',
    variantOption: sent.variantId === null ? null : 'Tamaño',
    variantValue: sent.variantId === null ? null : '15 kg',
    ...snap,
  },
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
  ...extra,
});
const norm = (value: unknown, sent: ExpirationIntakeInput) =>
  normalizeExpirationIntakeReceipt(value, sent);

describe('normalizeExpirationIntakeReceipt', () => {
  it('normalizes the historical variant and simple receipts', () => {
    const variant = variantSent();
    expect(norm(receiptFor(variant), variant)).toEqual(receiptFor(variant));
    const simple = sentOf();
    expect(norm(receiptFor(simple), simple)).toEqual(receiptFor(simple));
  });

  it('canonicalizes an offset instant and preserves raw labels verbatim', () => {
    const sent = variantSent();
    const out = norm(
      receiptFor(
        sent,
        { createdAt: '2026-06-22T12:30:00+02:00' },
        {
          branchId: '  ',
          branchName: '',
          productName: 'a\u0000b',
          unit: '\t',
          variantName: '\u009f',
        },
      ),
      sent,
    );
    expect(out?.createdAt).toBe(CREATED_AT);
    expect(out?.snapshot).toMatchObject({
      branchId: '  ',
      branchName: '',
      productName: 'a\u0000b',
      unit: '\t',
      variantName: '\u009f',
    });
  });

  it('binds identity case-insensitively and echoes canonical lowercase UUIDs', () => {
    expect(A_SOURCE.toUpperCase()).not.toBe(A_SOURCE);
    const simple: ExpirationIntakeInput = {
      ...sentOf(),
      sourceRequestId: A_SOURCE.toUpperCase(),
      productId: A_PRODUCT.toUpperCase(),
    };
    const s = norm(
      receiptFor(
        simple,
        { sourceRequestId: A_SOURCE },
        { productId: A_PRODUCT },
      ),
      simple,
    );
    expect(s?.sourceRequestId).toBe(A_SOURCE);
    expect(s?.snapshot.productId).toBe(A_PRODUCT);
    expect(s?.snapshot.variantId).toBeNull();
    const variant: ExpirationIntakeInput = {
      ...variantSent(),
      sourceRequestId: A_SOURCE.toUpperCase(),
      productId: A_PRODUCT.toUpperCase(),
      variantId: A_VARIANT.toUpperCase(),
    };
    const v = norm(
      receiptFor(
        variant,
        { sourceRequestId: A_SOURCE },
        { productId: A_PRODUCT, variantId: A_VARIANT },
      ),
      variant,
    );
    expect(v?.sourceRequestId).toBe(A_SOURCE);
    expect(v?.snapshot.productId).toBe(A_PRODUCT);
    expect(v?.snapshot.variantId).toBe(A_VARIANT);
  });

  it('requires every declared receipt and snapshot key', () => {
    const sent = sentOf();
    const base = receiptFor(sent);
    const snap = base.snapshot as Rec;
    for (const k of Object.keys(base)) {
      expect(norm(omit(base, k), sent)).toBeNull();
    }
    for (const k of Object.keys(snap)) {
      expect(norm({ ...base, snapshot: omit(snap, k) }, sent)).toBeNull();
    }
  });

  it.each<[string, (s: ExpirationIntakeInput) => Rec]>([
    ['sourceRequestId', (s) => receiptFor(s, { sourceRequestId: A_VARIANT })],
    ['type', (s) => receiptFor(s, { type: 'RESTOCK' })],
    ['productId', (s) => receiptFor(s, {}, { productId: A_VARIANT })],
    ['variantId', (s) => receiptFor(s, {}, { variantId: null })],
    ['nameless variant', (s) => receiptFor(s, {}, { variantName: null })],
    ['status', (s) => receiptFor(s, { status: 'RESOLVED' })],
    ['version', (s) => receiptFor(s, { version: 2 })],
    ['resolution', (s) => receiptFor(s, { resolution: { action: 'X' } })],
    ['applyBefore', (s) => receiptFor(s, { applyBefore: CREATED_AT })],
    ['supersedes', (s) => receiptFor(s, { supersedesDecisionId: A_VARIANT })],
    ['missing status', (s) => omit(receiptFor(s), 'status')],
    ['missing applyBefore', (s) => omit(receiptFor(s), 'applyBefore')],
  ])('rejects a non-historical or unbound receipt (%s)', (_l, build) => {
    const sent = variantSent();
    expect(norm(build(sent), sent)).toBeNull();
  });

  it('rejects a receipt variant on a simple-product intake', () => {
    const sent = sentOf();
    expect(
      norm(receiptFor(sent, {}, { variantId: A_VARIANT }), sent),
    ).toBeNull();
  });

  it.each<[string, (s: ExpirationIntakeInput) => unknown]>([
    ['top extra', (s) => receiptFor(s, { tenantId: U.source })],
    ['snapshot extra sku', (s) => receiptFor(s, {}, { sku: 'SKU-9' })],
    ['snapshot extra stock', (s) => receiptFor(s, {}, { stock: 3 })],
    ['non-uuid id', (s) => receiptFor(s, { id: 'x' })],
    ['bad sourceRequestId', (s) => receiptFor(s, { sourceRequestId: 'x' })],
    ['bad productId', (s) => receiptFor(s, {}, { productId: 'x' })],
    ['bad variantId', (s) => receiptFor(s, {}, { variantId: 'x' })],
    ['non-string productName', (s) => receiptFor(s, {}, { productName: 7 })],
    ['numeric branchId', (s) => receiptFor(s, {}, { branchId: 7 })],
    ['null unit', (s) => receiptFor(s, {}, { unit: null })],
    ['numeric variantName', (s) => receiptFor(s, {}, { variantName: 7 })],
    ['simple stray name', (s) => receiptFor(s, {}, { variantName: 'X' })],
    ['simple stray option', (s) => receiptFor(s, {}, { variantOption: 'X' })],
    ['simple stray value', (s) => receiptFor(s, {}, { variantValue: 'X' })],
    [
      'impossible createdAt',
      (s) => receiptFor(s, { createdAt: '2026-02-30T10:00:00Z' }),
    ],
    ['date-only createdAt', (s) => receiptFor(s, { createdAt: '2026-06-22' })],
    ['array snapshot', (s) => receiptFor(s, { snapshot: [] })],
    ['symbol key', (s) => ({ ...receiptFor(s), [Symbol('x')]: 1 })],
    ['null input', () => null],
    ['string input', () => 'nope'],
    ['array input', () => []],
  ])('rejects a malformed receipt (%s)', (_l, build) => {
    const sent = sentOf();
    expect(norm(build(sent), sent)).toBeNull();
  });

  it('accepts an empty string variant name', () => {
    const sent = variantSent();
    const r = receiptFor(sent, {}, { variantName: '' });
    expect(norm(r, sent)?.snapshot.variantName).toBe('');
  });

  it('fails closed on hostile getters, proxies and a missing sent intake', () => {
    const sent = variantSent();
    const getter = receiptFor(sent);
    Object.defineProperty(getter, 'createdAt', { enumerable: true, get: boom });
    expect(norm(getter, sent)).toBeNull();
    expect(norm(proxy(receiptFor(sent), 'ownKeys'), sent)).toBeNull();
    expect(norm(proxy(receiptFor(sent), 'get'), sent)).toBeNull();
    expect(norm(receiptFor(sent), null as never)).toBeNull();
  });
});
