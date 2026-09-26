/**
 * SCA-1a2 (test-only): adversarial/boundary characterization of the SCA-1a1
 * pure offer/acceptance marker contract, restoring the deferred hostile-input,
 * exhaustive-variant, boundary and match-drift matrix. Characterization only:
 * no production behavior changes and no store/provider/backend access.
 */
import {
  matchShippingCustomerAcceptance as match,
  normalizeShippingCustomerAcceptance as normalizeAcceptance,
  normalizeShippingCustomerOffer as normalizeOffer,
} from './shipping-customer-acceptance';

const REQ = 'abcdef123456',
  OTHER_REQ = 'fedcba654321',
  DRAFT = '2026-06-23T12:00:00.000Z',
  OFFERED = '2026-06-23T12:00:05.000Z',
  EXPIRES = '2026-06-23T12:30:05.000Z',
  ACCEPTED = '2026-06-23T12:05:00.000Z',
  OUT_ID = 'wamid.HBgLoutbound=',
  IN_ID = 'wamid.HBgLinbound=',
  MERCH = 100_000,
  CHARGE = 12_900,
  TOTAL = 112_900,
  INT32_MAX = 2_147_483_647;

const offerOf = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: DRAFT,
  offeredAt: OFFERED,
  expiresAt: EXPIRES,
  merchandiseCents: MERCH,
  chargeCents: CHARGE,
  expectedTotalCents: TOTAL,
  providerMessageId: OUT_ID,
  ...overrides,
});

const acceptOf = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: DRAFT,
  merchandiseCents: MERCH,
  chargeCents: CHARGE,
  expectedTotalCents: TOTAL,
  acceptedAt: ACCEPTED,
  inboundMessageId: IN_ID,
  ...overrides,
});

const both = (patch: Record<string, unknown>): [unknown, unknown] => [
  normalizeOffer(offerOf(patch)),
  normalizeAcceptance(acceptOf(patch)),
];

const nullProto = (
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const raw = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) raw[key] = source[key];
  return raw;
};

const withAccessorKey = (
  source: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> => {
  const raw = { ...source };
  Object.defineProperty(raw, key, { enumerable: true, get: () => value });
  return raw;
};

const withSymbolKey = (
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const raw = { ...source };
  Object.defineProperty(raw, Symbol('extra'), { enumerable: true, value: 1 });
  return raw;
};

const revoked = (): unknown => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
};

const throwingDescriptor = (source: Record<string, unknown>): unknown =>
  new Proxy(source, {
    getOwnPropertyDescriptor: () => {
      throw new Error('hostile getOwnPropertyDescriptor');
    },
  });

const hostileShapes = (
  source: Record<string, unknown>,
): Array<[string, unknown]> => [
  ['null', null],
  ['array', []],
  ['inherited prototype', Object.create(source)],
  ['revoked proxy', revoked()],
  ['symbol key', withSymbolKey(source)],
  ['accessor key', withAccessorKey(source, 'requestId', REQ)],
  ['throwing getOwnPropertyDescriptor', throwingDescriptor(source)],
];

const NON_CANONICAL_ISO: Array<[string, string]> = [
  ['no milliseconds', '2026-06-23T12:00:05Z'],
  ['offset form', '2026-06-23T12:00:05.000+00:00'],
  ['extra precision', '2026-06-23T12:00:05.0000Z'],
  ['negative epoch', '1969-12-31T23:59:59.000Z'],
];

describe('hostile object shapes', () => {
  it.each(hostileShapes(offerOf()))(
    'rejects hostile offer shape: %s',
    (_label, raw) => {
      expect(normalizeOffer(raw)).toBeNull();
    },
  );

  it.each(hostileShapes(acceptOf()))(
    'rejects hostile acceptance shape: %s',
    (_label, raw) => {
      expect(normalizeAcceptance(raw)).toBeNull();
    },
  );

  it('accepts plain and null-prototype exact-key markers', () => {
    expect(normalizeOffer(offerOf())).not.toBeNull();
    expect(normalizeOffer(nullProto(offerOf()))).not.toBeNull();
    expect(normalizeAcceptance(acceptOf())).not.toBeNull();
    expect(normalizeAcceptance(nullProto(acceptOf()))).not.toBeNull();
  });

  it('rejects accessor-backed markers without invoking any getter', () => {
    let reads = 0;
    const accessorized = (
      source: Record<string, unknown>,
    ): Record<string, unknown> => {
      const raw: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(source)) {
        Object.defineProperty(raw, key, {
          enumerable: true,
          get: () => {
            reads += 1;
            return value;
          },
        });
      }
      return raw;
    };
    expect(normalizeOffer(accessorized(offerOf()))).toBeNull();
    expect(normalizeAcceptance(accessorized(acceptOf()))).toBeNull();
    expect(reads).toBe(0);
  });

  it('normalizes through a proxy without invoking its get trap', () => {
    let gets = 0;
    const proxy = new Proxy(offerOf(), {
      get: () => {
        gets += 1;
        throw new Error('hostile get');
      },
    });
    expect(normalizeOffer(proxy)).not.toBeNull();
    expect(gets).toBe(0);
  });

  it('returns frozen markers whose fields cannot be replaced', () => {
    const offer = normalizeOffer(offerOf())!;
    const acceptance = normalizeAcceptance(acceptOf())!;
    expect([Object.isFrozen(offer), Object.isFrozen(acceptance)]).toEqual([
      true,
      true,
    ]);
    try {
      (offer as unknown as Record<string, unknown>).requestId = OTHER_REQ;
      (acceptance as unknown as Record<string, unknown>).requestId = OTHER_REQ;
    } catch {
      // Frozen writes throw in strict mode; values must still hold below.
    }
    expect([offer.requestId, acceptance.requestId]).toEqual([REQ, REQ]);
  });

  it('detaches normalized results from the source object', () => {
    const source = offerOf();
    const offer = normalizeOffer(source)!;
    source.requestId = OTHER_REQ;
    source.merchandiseCents = 1;
    expect([offer.requestId, offer.merchandiseCents]).toEqual([REQ, MERCH]);
  });
});

describe('exhaustive requestId and schemaVersion variants', () => {
  it.each<[string, unknown]>([
    ['uppercase hex', 'ABCDEF123456'],
    ['too short', 'abcdef12345'],
    ['too long', 'abcdef1234567'],
    ['non-hex letters', 'gggggggggggg'],
    ['empty', ''],
  ])('rejects requestId %s on both markers', (_label, requestId) => {
    expect(both({ requestId })).toEqual([null, null]);
  });

  it.each<[string, unknown]>([
    ['zero', 0],
    ['two', 2],
    ['string', '1'],
    ['undefined', undefined],
  ])('rejects schemaVersion %s on both markers', (_label, schemaVersion) => {
    expect(both({ schemaVersion })).toEqual([null, null]);
  });
});

describe('exhaustive ISO variants', () => {
  it.each(NON_CANONICAL_ISO)(
    'rejects non-canonical offeredAt: %s',
    (_label, offeredAt) => {
      expect(normalizeOffer(offerOf({ offeredAt }))).toBeNull();
    },
  );

  it.each(NON_CANONICAL_ISO)(
    'rejects non-canonical acceptedAt: %s',
    (_label, acceptedAt) => {
      expect(normalizeAcceptance(acceptOf({ acceptedAt }))).toBeNull();
    },
  );
});

describe('time ordering', () => {
  it.each<[string, Record<string, unknown>]>([
    [
      'draftCreatedAt after offeredAt',
      { draftCreatedAt: '2026-06-23T12:00:06.000Z' },
    ],
    ['offeredAt after expiresAt', { offeredAt: '2026-06-23T12:31:00.000Z' }],
    ['offeredAt equal expiresAt', { expiresAt: OFFERED }],
  ])('rejects offer ordering: %s', (_label, patch) => {
    expect(normalizeOffer(offerOf(patch))).toBeNull();
  });

  it('accepts draftCreatedAt equal to offeredAt and a valid window', () => {
    expect(normalizeOffer(offerOf({ draftCreatedAt: OFFERED }))).not.toBeNull();
    expect(
      normalizeOffer(offerOf({ expiresAt: '2026-06-23T12:00:06.000Z' })),
    ).not.toBeNull();
  });

  it('rejects acceptance acceptedAt before draft but allows equality', () => {
    expect(
      normalizeAcceptance(acceptOf({ acceptedAt: '2026-06-23T11:59:59.999Z' })),
    ).toBeNull();
    expect(normalizeAcceptance(acceptOf({ acceptedAt: DRAFT }))).not.toBeNull();
  });
});

describe('amount and int32 boundaries', () => {
  it.each<[string, Record<string, unknown>]>([
    ['negative merchandise', { merchandiseCents: -1 }],
    ['fractional merchandise', { merchandiseCents: 1.5 }],
    ['NaN merchandise', { merchandiseCents: NaN }],
    ['zero charge', { chargeCents: 0 }],
    ['negative charge', { chargeCents: -1 }],
    ['NaN charge', { chargeCents: NaN }],
    ['total mismatch', { expectedTotalCents: TOTAL + 1 }],
  ])('rejects amounts %s on both markers', (_label, patch) => {
    expect(both(patch)).toEqual([null, null]);
  });

  it('accepts the exact int32 freight-inclusive boundary', () => {
    const atMax = {
      merchandiseCents: INT32_MAX - 1,
      chargeCents: 1,
      expectedTotalCents: INT32_MAX,
    };
    expect(normalizeOffer(offerOf(atMax))).not.toBeNull();
    expect(normalizeAcceptance(acceptOf(atMax))).not.toBeNull();
  });

  it('rejects a freight-inclusive total above int32 and accepts zero merchandise', () => {
    expect(
      both({
        merchandiseCents: INT32_MAX,
        chargeCents: 1,
        expectedTotalCents: INT32_MAX + 1,
      }),
    ).toEqual([null, null]);
    expect(
      both({
        merchandiseCents: 0,
        chargeCents: CHARGE,
        expectedTotalCents: CHARGE,
      }).every((value) => value !== null),
    ).toBe(true);
  });
});

describe('bounded id variants', () => {
  it('accepts ids at the 1 and 128 length boundaries', () => {
    for (const id of ['a', 'a'.repeat(128)]) {
      expect(normalizeOffer(offerOf({ providerMessageId: id }))).not.toBeNull();
      expect(
        normalizeAcceptance(acceptOf({ inboundMessageId: id })),
      ).not.toBeNull();
    }
  });

  it.each<[string, unknown]>([
    ['empty', ''],
    ['blank space', ' '],
    ['129 chars', 'a'.repeat(129)],
    ['number', 7],
  ])('rejects providerMessageId %s', (_label, providerMessageId) => {
    expect(normalizeOffer(offerOf({ providerMessageId }))).toBeNull();
  });

  it.each<[string, unknown]>([
    ['empty', ''],
    ['blank space', ' '],
    ['129 chars', 'a'.repeat(129)],
    ['null', null],
  ])('rejects inboundMessageId %s', (_label, inboundMessageId) => {
    expect(normalizeAcceptance(acceptOf({ inboundMessageId }))).toBeNull();
  });
});
describe('match drift, boundaries and malformed inputs', () => {
  it('matches a valid acceptance to its offer without mutating inputs', () => {
    const offer = offerOf();
    const acceptance = acceptOf();
    const before = [JSON.stringify(offer), JSON.stringify(acceptance)];
    expect(match(offer, acceptance)).toBe(true);
    expect([JSON.stringify(offer), JSON.stringify(acceptance)]).toEqual(before);
  });

  it.each<[string, Record<string, unknown>]>([
    ['requestId', { requestId: OTHER_REQ }],
    ['draftCreatedAt', { draftCreatedAt: '2026-06-23T12:00:01.000Z' }],
    [
      'merchandiseCents',
      { merchandiseCents: MERCH + 1, expectedTotalCents: TOTAL + 1 },
    ],
    ['chargeCents', { chargeCents: CHARGE + 1, expectedTotalCents: TOTAL + 1 }],
    ['expectedTotalCents', { expectedTotalCents: TOTAL + 1 }],
  ])('rejects acceptance drift on %s', (_label, patch) => {
    expect(match(offerOf(), acceptOf(patch))).toBe(false);
  });

  it.each<[string, string, boolean]>([
    ['exactly offeredAt', OFFERED, true],
    ['one ms before offeredAt', '2026-06-23T12:00:04.999Z', false],
    ['one ms before expiresAt', '2026-06-23T12:30:04.999Z', true],
    ['exactly expiresAt', EXPIRES, false],
  ])(
    'match time boundary %s resolves to %s',
    (_label, acceptedAt, expected) => {
      expect(match(offerOf(), acceptOf({ acceptedAt }))).toBe(expected);
    },
  );

  it.each<[string, unknown, unknown]>([
    ['null offer', null, acceptOf()],
    ['null acceptance', offerOf(), null],
    ['excess-key acceptance', offerOf(), { ...acceptOf(), extra: 1 }],
    ['revoked offer', revoked(), acceptOf()],
    [
      'accessor acceptance',
      offerOf(),
      withAccessorKey(acceptOf(), 'acceptedAt', ACCEPTED),
    ],
    ['expired offer', offerOf({ expiresAt: OFFERED }), acceptOf()],
  ])('match fails closed on %s', (_label, offer, acceptance) => {
    expect(match(offer, acceptance)).toBe(false);
  });
});
