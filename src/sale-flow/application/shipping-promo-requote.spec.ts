import type { ToolErrorResult } from '../domain/tool-result';
import {
  bindShippingPromoReQuote,
  type ShippingPromoChargePin,
  type ShippingPromoReQuoteBinding,
} from './shipping-promo-requote';

// E4-2b1: bind a backend PROMO_RE_QUOTE to the merchandise remainder by
// subtracting freight exactly once; every raw field must match the mapped one.
const CHARGE = 6_900;
const MERCHANDISE = 60_000;
const SENT_TOTAL = MERCHANDISE + CHARGE; // 66_900 freight-inclusive
const RECOMPUTED = 65_000; // 58_100 merchandise + 6_900 freight
const REMAINDER = RECOMPUTED - CHARGE; // 58_100

type Over = Record<string, unknown>;

const promoError = (over: Over = {}): ToolErrorResult =>
  ({
    ok: false,
    error: {
      kind: 'promoReQuote',
      retryable: false,
      recomputedTotalCents: RECOMPUTED,
      expectedTotalCents: SENT_TOTAL,
      discountCents: 1_900,
      ...over,
    },
  }) as unknown as ToolErrorResult;

const errorOfKind = (kind: string): ToolErrorResult =>
  ({
    ok: false,
    error: { kind, retryable: false },
  }) as unknown as ToolErrorResult;

const rawBody = (over: Over = {}): unknown => ({
  error: 'PROMO_RE_QUOTE',
  recomputedTotalCents: RECOMPUTED,
  expectedTotalCents: SENT_TOTAL,
  discountCents: 1_900,
  shippingChargeCents: CHARGE,
  ...over,
});

const pin = (
  chargeCents: unknown = CHARGE,
  expectedTotalCents: unknown = SENT_TOTAL,
): ShippingPromoChargePin =>
  ({ chargeCents, expectedTotalCents }) as unknown as ShippingPromoChargePin;

const bind = (
  result: unknown = promoError(),
  body: unknown = rawBody(),
  pinned: unknown = pin(),
): ShippingPromoReQuoteBinding =>
  bindShippingPromoReQuote(
    result as ToolErrorResult,
    body,
    pinned as ShippingPromoChargePin,
  );

const BLOCKED = { kind: 'blocked' } as const;

describe('bindShippingPromoReQuote', () => {
  describe('matched binding', () => {
    it('subtracts the charged freight once to recover the merchandise remainder', () => {
      expect(bind(promoError(), rawBody(), pin())).toEqual({
        kind: 'merchandise_remainder',
        merchandiseTotalCents: REMAINDER,
      });
    });

    it('binds a zero merchandise remainder when freight is the whole total', () => {
      expect(
        bind(
          promoError({
            recomputedTotalCents: CHARGE,
            expectedTotalCents: CHARGE,
            discountCents: 0,
          }),
          rawBody({
            recomputedTotalCents: CHARGE,
            expectedTotalCents: CHARGE,
            discountCents: 0,
          }),
          pin(CHARGE, CHARGE),
        ),
      ).toEqual({ kind: 'merchandise_remainder', merchandiseTotalCents: 0 });
    });

    it('accepts the backend int32 recomputed ceiling', () => {
      const recomputed = 2_147_483_647;
      expect(
        bind(
          promoError({
            recomputedTotalCents: recomputed,
            expectedTotalCents: recomputed,
          }),
          rawBody({
            recomputedTotalCents: recomputed,
            expectedTotalCents: recomputed,
            shippingChargeCents: 1,
          }),
          pin(1, recomputed),
        ),
      ).toEqual({
        kind: 'merchandise_remainder',
        merchandiseTotalCents: recomputed - 1,
      });
    });

    it('exposes only the merchandise remainder and freezes it', () => {
      const bound = bind();
      expect(Object.isFrozen(bound)).toBe(true);
      expect(Object.keys(bound)).toEqual(['kind', 'merchandiseTotalCents']);
      expect(bound).toEqual({
        kind: 'merchandise_remainder',
        merchandiseTotalCents: REMAINDER,
      });
    });
  });

  describe('blocked on the mapped payload', () => {
    const blockedMapped: Array<[string, ToolErrorResult]> = [
      ['negative recomputed', promoError({ recomputedTotalCents: -1 })],
      [
        'fractional recomputed',
        promoError({ recomputedTotalCents: RECOMPUTED + 0.5 }),
      ],
      [
        'unsafe recomputed',
        promoError({ recomputedTotalCents: Number.MAX_SAFE_INTEGER + 1 }),
      ],
      [
        'int32 overflow recomputed',
        promoError({ recomputedTotalCents: 2_147_483_648 }),
      ],
      ['negative expected', promoError({ expectedTotalCents: -1 })],
      [
        'fractional expected',
        promoError({ expectedTotalCents: SENT_TOTAL + 0.5 }),
      ],
      [
        'unsafe expected',
        promoError({ expectedTotalCents: Number.MAX_SAFE_INTEGER + 1 }),
      ],
      ['negative discount', promoError({ discountCents: -1 })],
      ['fractional discount', promoError({ discountCents: 1.5 })],
      [
        'unsafe discount',
        promoError({ discountCents: Number.MAX_SAFE_INTEGER + 1 }),
      ],
      ['wrong kind', errorOfKind('validation')],
      ['success envelope', { ok: true } as unknown as ToolErrorResult],
    ];

    it.each(blockedMapped)('blocks %s', (_name, result) => {
      expect(bind(result)).toEqual(BLOCKED);
    });
  });

  describe('blocked on the pinned slice', () => {
    const blockedPins: Array<[string, ShippingPromoChargePin]> = [
      ['zero charge', pin(0)],
      ['negative charge', pin(-1)],
      ['fractional charge', pin(CHARGE + 0.5)],
      ['int32 overflow charge', pin(2_147_483_648)],
      ['zero expected', pin(CHARGE, 0)],
      ['negative expected', pin(CHARGE, -1)],
      ['fractional expected', pin(CHARGE, SENT_TOTAL + 0.5)],
      ['unsafe expected', pin(CHARGE, Number.MAX_SAFE_INTEGER + 1)],
    ];

    it.each(blockedPins)('blocks %s', (_name, pinned) => {
      expect(bind(promoError(), rawBody(), pinned)).toEqual(BLOCKED);
    });
  });

  describe('blocked on contradiction', () => {
    it('blocks when the mapped expected total differs from the pinned sent total', () => {
      expect(bind(promoError({ expectedTotalCents: SENT_TOTAL + 1 }))).toEqual(
        BLOCKED,
      );
      expect(bind(promoError({ expectedTotalCents: SENT_TOTAL - 1 }))).toEqual(
        BLOCKED,
      );
    });

    it('blocks a recomputed total below the charged freight', () => {
      expect(bind(promoError({ recomputedTotalCents: CHARGE - 1 }))).toEqual(
        BLOCKED,
      );
    });
  });

  describe('blocked on the raw body', () => {
    const blockedBodies: Array<[string, unknown]> = [
      ['non-record array', []],
      ['null body', null],
      ['primitive body', 'x'],
    ];

    it.each(blockedBodies)('blocks a %s', (_name, body) => {
      expect(bind(promoError(), body)).toEqual(BLOCKED);
    });

    const blockedRawFields: Array<[string, Over]> = [
      ['missing shippingChargeCents', { shippingChargeCents: undefined }],
      ['null shippingChargeCents', { shippingChargeCents: null }],
      ['string shippingChargeCents', { shippingChargeCents: '6900' }],
      ['fractional shippingChargeCents', { shippingChargeCents: CHARGE + 0.5 }],
      ['mismatched shippingChargeCents', { shippingChargeCents: CHARGE + 1 }],
      ['raw recomputed differs', { recomputedTotalCents: RECOMPUTED + 1 }],
      ['raw expected differs', { expectedTotalCents: SENT_TOTAL + 1 }],
      ['raw discount differs', { discountCents: 1_901 }],
      ['raw recomputed missing', { recomputedTotalCents: undefined }],
      ['raw expected missing', { expectedTotalCents: undefined }],
      ['raw discount missing', { discountCents: undefined }],
    ];

    it.each(blockedRawFields)('blocks a %s', (_name, over) => {
      expect(bind(promoError(), rawBody(over))).toEqual(BLOCKED);
    });
  });

  describe('fail-closed on hostile inputs', () => {
    it('blocks a throwing mapped-error getter without throwing', () => {
      const result: Record<string, unknown> = { ok: false };
      Object.defineProperty(result, 'error', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      expect(bind(result)).toEqual(BLOCKED);
    });

    it('blocks a throwing raw-body getter without throwing', () => {
      const body: Record<string, unknown> = {};
      Object.defineProperty(body, 'shippingChargeCents', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      expect(bind(promoError(), body)).toEqual(BLOCKED);
    });

    it('blocks a throwing pinned getter without throwing', () => {
      const pinned: Record<string, unknown> = {};
      Object.defineProperty(pinned, 'chargeCents', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      Object.defineProperty(pinned, 'expectedTotalCents', {
        enumerable: true,
        value: SENT_TOTAL,
      });
      expect(bind(promoError(), rawBody(), pinned)).toEqual(BLOCKED);
    });

    it('blocks non-plain mapped, raw-body, and pinned inputs', () => {
      expect(bind([])).toEqual(BLOCKED);
      expect(bind(new Date())).toEqual(BLOCKED);
      expect(bind(promoError(), [])).toEqual(BLOCKED);
      expect(bind(promoError(), rawBody(), [])).toEqual(BLOCKED);
    });
  });
});
