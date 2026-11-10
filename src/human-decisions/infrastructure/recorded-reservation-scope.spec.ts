import { reservationTopicKey } from '../domain/shared-reservation';
import { scopedRecordedQuery } from './recorded-reservation-scope';

const BASE = "SELECT x FROM t WHERE sender_id = $1 AND status = 'ACTIVE'";
const KEY = '848D8B89-B323-5A4F-952E-41EBCC00D733';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';

describe('reservationTopicKey (mirrors migration 400 topic_key)', () => {
  it('keys LEGACY_OPS by sender, a variant first, else the product', () => {
    expect(reservationTopicKey('LEGACY_OPS', null)).toBe('legacy');
    expect(
      reservationTopicKey('RESTOCK', {
        productId: PRODUCT,
        variantId: VARIANT,
      }),
    ).toBe(`variant:${VARIANT}`);
    expect(
      reservationTopicKey('EXPIRATION', {
        productId: PRODUCT,
        variantId: null,
      }),
    ).toBe(`product:${PRODUCT}`);
    expect(
      reservationTopicKey('RESTOCK', { productId: PRODUCT.toUpperCase() }),
    ).toBe(`product:${PRODUCT}`);
  });

  it('returns null without a usable subject id', () => {
    expect(reservationTopicKey('RESTOCK', null)).toBeNull();
    expect(reservationTopicKey('RESTOCK', { productId: '' })).toBeNull();
    expect(
      reservationTopicKey('RESTOCK', { productId: PRODUCT, variantId: 7 }),
    ).toBeNull();
  });
});

describe('scopedRecordedQuery', () => {
  it('keeps the unscoped per-sender read unchanged', () => {
    expect(scopedRecordedQuery(BASE, 'RESTOCK', 's', undefined)).toEqual({
      text: BASE,
      params: ['s'],
    });
  });

  it('narrows to one route and request key or topic', () => {
    expect(
      scopedRecordedQuery(BASE, 'EXPIRATION', 's', { requestKey: KEY }),
    ).toEqual({
      text: `${BASE} AND route = 'EXPIRATION' AND request_key = $2`,
      params: ['s', KEY],
    });
    expect(
      scopedRecordedQuery(BASE, 'RESTOCK', 's', {
        topicKey: `variant:${VARIANT}`,
      }),
    ).toEqual({
      text: `${BASE} AND route = 'RESTOCK' AND topic_key = $2`,
      params: ['s', `variant:${VARIANT}`],
    });
  });

  it('rejects a malformed scope', () => {
    for (const scope of [
      { requestKey: 'nope' },
      { topicKey: 'legacy' },
      { topicKey: "variant:x' OR 1=1 --" },
      { requestKey: 1 as unknown as string },
    ]) {
      expect(scopedRecordedQuery(BASE, 'RESTOCK', 's', scope)).toBeNull();
    }
  });
});
