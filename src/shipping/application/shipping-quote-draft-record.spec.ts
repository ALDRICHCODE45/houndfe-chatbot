import {
  buildShippingQuoteDraftRecord as build,
  normalizeShippingQuoteDraftRecord as normalize,
  SHIPPING_QUOTE_DRAFT_KEY,
  SHIPPING_QUOTE_DRAFT_TTL_MS as TTL,
} from './shipping-quote-draft-record';
import type { ShippingQuoteDraft } from './shipping-quote-draft';

const NOW = '2026-06-23T12:00:00.000Z',
  MS = Date.parse(NOW),
  FB = '2026-06-23T12:30:00.000Z',
  SEC = 'svc_secret';
const R = (
  o: Record<string, unknown> = {},
): ShippingQuoteDraft['selectedRate'] => ({
  rateId: 'r1',
  carrierName: 'C',
  serviceName: 'S',
  priceCents: 12_900,
  currency: 'MXN',
  estimatedDeliveryDays: 2,
  validUntil: null,
  ...o,
});
const D = (o: Record<string, unknown> = {}): ShippingQuoteDraft => ({
  quoteId: 'q1',
  selectedRate: R(),
  providerExpiresAt: null,
  bestRateCents: 12_900,
  totalCreditCents: 0,
  appliedCreditCents: 0,
  unusedCreditCents: 0,
  qualifyingUnitCount: 0,
  customerPaysCents: 12_900,
  ...o,
});

describe('build', () => {
  it('v1 frozen exact-key record with fallback expiry', () => {
    expect([TTL, SHIPPING_QUOTE_DRAFT_KEY]).toEqual([
      30 * 60 * 1000,
      'shippingQuoteDraft',
    ]);
    const r = build(D(), MS)!;
    expect([r.schemaVersion, r.createdAt, r.expiresAt]).toEqual([1, NOW, FB]);
    expect(Object.keys(r).sort().join()).toBe(
      'createdAt,draft,expiresAt,schemaVersion',
    );
    expect([r, r.draft, r.draft.selectedRate].every(Object.isFrozen)).toBe(
      true,
    );
  });
  it.each([
    [{ providerExpiresAt: '2026-06-23T13:00:00.000Z' }, FB],
    [
      { selectedRate: R({ validUntil: '2026-06-23T12:05:00.000Z' }) },
      '2026-06-23T12:05:00.000Z',
    ],
  ] as Array<[Record<string, unknown>, string]>)(
    'honors provider/validUntil boundaries',
    (p, exp) => {
      expect(build(D(p), MS)!.expiresAt).toBe(exp);
    },
  );
  it('rejects provider/rate expiry at or before creation', () => {
    const at = new Date(MS).toISOString(),
      before = new Date(MS - 1).toISOString();
    expect([
      build(D({ providerExpiresAt: at }), MS),
      build(D({ providerExpiresAt: before }), MS),
      build(D({ selectedRate: R({ validUntil: at }) }), MS),
      build(D({ selectedRate: R({ validUntil: before }) }), MS),
    ]).toEqual([null, null, null, null]);
  });
  it('rejects financial identity violations', () => {
    expect([
      build(
        D({
          totalCreditCents: 12_000,
          unusedCreditCents: 12_000,
          qualifyingUnitCount: 1,
        }),
        MS,
      ),
      build(
        D({
          totalCreditCents: 12_000,
          appliedCreditCents: 12_000,
          customerPaysCents: 900,
        }),
        MS,
      ),
      build(D({ selectedRate: R({ priceCents: 12_901 }) }), MS),
    ]).toEqual([null, null, null]);
  });
  it('hostile/stateful/throwing/revoked/bad field/extras all fail closed or strip secrets', () => {
    const reads: Record<string, number> = {};
    const src: Record<string, unknown> = {};
    const base = D() as unknown as Record<string, unknown>;
    for (const k of Object.keys(base))
      Object.defineProperty(src, k, {
        get: () => {
          reads[k] = (reads[k] ?? 0) + 1;
          return reads[k] === 1 ? base[k] : SEC;
        },
      });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect([
      JSON.stringify(
        build(
          { ...D(), token: SEC, rawProviderBody: SEC, customerAddress: SEC },
          MS,
        ),
      ).includes(SEC),
      JSON.stringify(build(src, MS)).includes(SEC),
      Object.values(reads),
      build(null, MS),
      build(42, MS),
      build([], MS),
      build('x', MS),
      build({}, MS),
      build(
        {
          get quoteId(): never {
            throw new Error('x');
          },
        },
        MS,
      ),
      build(proxy, MS),
      build(D({ bestRateCents: -1 }), MS),
      build(D({ selectedRate: R({ currency: 'USD' }) }), MS),
    ]).toEqual([
      false,
      false,
      [1, 1, 1, 1, 1, 1, 1, 1, 1],
      ...Array<null>(9).fill(null),
    ]);
  });
  it.each<unknown>([NaN, Infinity, -1, 1.5, 'now', null, {}, 8.64e15])(
    'rejects invalid nowMs',
    (n) => expect(build(D(), n as number)).toBeNull(),
  );
});

describe('normalize', () => {
  it('returns fresh deep-frozen exact-key copy with no source references', () => {
    const stored = build(D(), MS)!;
    const n = normalize(stored)!;
    expect([
      n !== stored,
      n.draft !== stored.draft,
      n.draft.selectedRate !== stored.draft.selectedRate,
      Object.isFrozen(n),
      Object.isFrozen(n.draft.selectedRate),
      Object.keys(n).sort().join(),
    ]).toEqual([
      true,
      true,
      true,
      true,
      true,
      'createdAt,draft,expiresAt,schemaVersion',
    ]);
  });
  it.each<unknown>([
    { ...build(D(), MS)!, schemaVersion: 2 },
    { schemaVersion: 1, draft: D(), createdAt: FB, expiresAt: NOW },
    {
      schemaVersion: 1,
      draft: D(),
      createdAt: '2026-06-23T12:00:00',
      expiresAt: FB,
    },
    'x',
    null,
    new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile getter');
        },
      },
    ),
  ])('returns null for structurally invalid record', (raw) =>
    expect(normalize(raw)).toBeNull(),
  );
  it('rejects expiresAt exceeding createdAt + 30m (TTL cap)', () => {
    const stored = build(D(), MS)!;
    expect(
      normalize({ ...stored, expiresAt: new Date(MS + TTL + 1).toISOString() }),
    ).toBeNull();
  });
  it('rejects tampered expiresAt exceeding providerExpiresAt or selectedRate.validUntil', () => {
    const stored = build(
      D({
        providerExpiresAt: '2026-06-23T12:20:00.000Z',
        selectedRate: R({ validUntil: '2026-06-23T12:05:00.000Z' }),
      }),
      MS,
    )!;
    expect([
      normalize({ ...stored, expiresAt: '2026-06-23T12:30:00.000Z' }),
      normalize({ ...stored, expiresAt: '2026-06-23T12:10:00.000Z' }),
      normalize(stored),
    ]).toEqual([null, null, stored]);
  });
  it('rejects embedded draft identity break; does not mutate source', () => {
    const stored = build(D(), MS)!;
    const before = JSON.parse(JSON.stringify(stored)) as typeof stored;
    expect(
      normalize({
        ...stored,
        draft: { ...stored.draft, customerPaysCents: 5_000 },
      }),
    ).toBeNull();
    expect(stored).toEqual(before);
  });
});
