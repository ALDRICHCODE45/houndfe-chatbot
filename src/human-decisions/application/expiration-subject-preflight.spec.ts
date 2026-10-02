import { CatalogSession } from '../../conversation/domain/catalog-references';
import type { AgentMessage } from '../../conversation/domain/conversation-store';
import { preflightExpirationSubject } from './expiration-subject-preflight';

/** EXPIRATION subject grounding preflight spec: `grounded` proves ONLY the
 * source and subject are bound — not selection, intent, reservation,
 * registration, notification, or stock. */
const SENDER = 'whatsapp:+5215500000001';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const OTHER_PRODUCT = '66666666-6666-4666-8666-666666666666';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const OTHER_VARIANT = '77777777-7777-4777-8777-777777777777';
const EVENT = {
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId: 'wamid.ABC123',
};
const LATER_EVENT = { ...EVENT, messageId: 'wamid.ABC124' };
const SOURCE = 'a5162346-c1f7-568d-905a-b76ffcd68278';
const INTAKE = {
  sourceRequestId: SOURCE,
  type: 'EXPIRATION' as const,
  productId: PRODUCT,
  variantId: VARIANT,
};
const HISTORY: AgentMessage[] = [{ role: 'user', content: 'Croquetas' }];
const ROW = { variantId: VARIANT, name: 'Caja', option: null, value: null };
const catalog = (variants: unknown[], productId = PRODUCT) => ({
  productId,
  name: 'Croquetas premium',
  variants,
  stock: { status: 'out_of_stock', quantity: 0 },
});
const variantProduct = () => catalog([ROW]);
const simpleProduct = () => catalog([]);
const cand = (productId: string, variantId?: string | null) => ({
  productId,
  variantId,
});
const session = (
  products: unknown[],
  over: { senderId?: string; ttl?: number; clock?: () => number } = {},
) => {
  const s = new CatalogSession(
    over.senderId ?? SENDER,
    over.ttl ?? 60000,
    0,
    undefined,
    [],
    over.clock,
  );
  s.installSearch(s.beginSearch(), products);
  return s;
};
const ground = (over: Record<string, unknown> = {}) =>
  preflightExpirationSubject({
    senderId: SENDER,
    inboundEvent: EVENT,
    catalogSession: session([variantProduct()]),
    candidate: cand(PRODUCT, VARIANT),
    ...over,
  });
const CLARIFY = { status: 'clarification', reason: 'variant_required' };
const fail = (reason: string) => ({ status: 'blocked', reason });
const boom = () => {
  throw new Error('boom');
};

describe('preflightExpirationSubject', () => {
  const groundCases: Array<[object, object, string | null]> = [
    [variantProduct(), cand(PRODUCT, VARIANT), VARIANT],
    [simpleProduct(), cand(PRODUCT, null), null],
  ];
  it.each(groundCases)(
    'grounds an explicit subject %#',
    (product, candidate, variantId) => {
      expect(ground({ catalogSession: session([product]), candidate })).toEqual(
        {
          status: 'grounded',
          intake: { ...INTAKE, variantId },
        },
      );
    },
  );

  const clarifyCases: Array<[object, object]> = [
    [variantProduct(), cand(PRODUCT)],
    [variantProduct(), cand(PRODUCT, null)],
    [simpleProduct(), cand(PRODUCT)],
  ];
  it.each(clarifyCases)(
    'clarifies an ambiguous subject %#',
    (shape, candidate) => {
      expect(ground({ catalogSession: session([shape]), candidate })).toEqual(
        CLARIFY,
      );
    },
  );

  const blockCases: Array<[object, object, string]> = [
    [cand(OTHER_PRODUCT, VARIANT), variantProduct(), 'unknown_product'],
    [cand(PRODUCT, OTHER_VARIANT), variantProduct(), 'foreign_variant'],
    [cand(PRODUCT, VARIANT), simpleProduct(), 'foreign_variant'],
  ];
  it.each(blockCases)(
    'blocks a foreign reference %#',
    (candidate, shape, reason) => {
      expect(ground({ candidate, catalogSession: session([shape]) })).toEqual(
        fail(reason),
      );
    },
  );

  it.each<[unknown]>([
    [undefined],
    [null],
    ['x'],
    [[]],
    [{}],
    [{ productId: 'nope' }],
    [{ productId: PRODUCT, variantId: 1 }],
  ])('blocks a malformed candidate %#', (candidate) => {
    expect(ground({ candidate })).toEqual(fail('invalid_candidate'));
  });

  it('blocks a prototype-forged or hostile candidate without throwing', () => {
    const accessor = Object.defineProperty({}, 'productId', {
      get: boom,
      enumerable: true,
    });
    const traps: ProxyHandler<Record<string, unknown>>[] = [
      { get: boom },
      { ownKeys: boom },
      { getOwnPropertyDescriptor: boom },
      { getPrototypeOf: boom },
    ];
    const revocable = Proxy.revocable(
      { productId: PRODUCT, variantId: VARIANT },
      {},
    );
    revocable.revoke();
    const hostile: unknown[] = [
      accessor,
      Object.create({}),
      ...traps.map(
        (handler) =>
          new Proxy({ productId: PRODUCT, variantId: VARIANT }, handler),
      ),
      revocable.proxy,
    ];
    for (const candidate of hostile) {
      expect(() => ground({ candidate })).not.toThrow();
      expect(ground({ candidate })).toEqual(fail('invalid_candidate'));
    }
  });

  it('fails closed on a missing, lookalike, prototype, cross-sender, stale, invalidated, or pruned session', () => {
    let now = 1000;
    const expired = session([variantProduct()], { ttl: 100, clock: () => now });
    now = 1101;
    const invalidated = session([variantProduct()]);
    invalidated.beginSearch();
    const snapshot = session([variantProduct()]).snapshot()!;
    const pruned = new CatalogSession(SENDER, 60000, 1, snapshot, HISTORY);
    pruned.evidence(1);
    const sessions: unknown[] = [
      undefined,
      { senderId: SENDER, matches: () => true },
      Object.create(CatalogSession.prototype),
      session([variantProduct()], { senderId: 'another' }),
      expired,
      invalidated,
      pruned,
    ];
    for (const catalogSession of sessions) {
      expect(ground({ catalogSession })).toEqual(fail('catalog_unverified'));
    }
  });

  it('rejects a branded instance or subclass that overrides snapshot/resolve', () => {
    const forged = session([
      catalog([{ ...ROW, variantId: OTHER_VARIANT }], OTHER_PRODUCT),
    ]).snapshot()!;
    const subject = { productId: OTHER_PRODUCT, variantId: OTHER_VARIANT };
    const tampered = Object.assign(session([variantProduct()]), {
      snapshot: () => forged,
      resolve: () => subject,
    });
    class Forged extends CatalogSession {
      snapshot = (): ReturnType<CatalogSession['snapshot']> => forged;
      resolve = (() => subject) as unknown as CatalogSession['resolve'];
    }
    for (const catalogSession of [tampered, new Forged(SENDER, 60000, 0)]) {
      expect(
        ground({
          catalogSession,
          candidate: cand(OTHER_PRODUCT, OTHER_VARIANT),
        }),
      ).toEqual(fail('catalog_unverified'));
    }
  });

  it('fails closed on a missing, mismatched, or hostile inbound event', () => {
    const inboundEvents = [
      undefined,
      null,
      {},
      { ...EVENT, senderId: 'whatsapp:+5215500000999' },
      { ...EVENT, extra: 'x' },
      new Proxy({ ...EVENT }, { get: boom }),
    ];
    for (const inboundEvent of inboundEvents) {
      expect(() => ground({ inboundEvent })).not.toThrow();
      expect(ground({ inboundEvent })).toEqual(fail('identity_unbound'));
    }
  });

  it('derives a deterministic source and a distinct id for a later turn', () => {
    const later = ground({ inboundEvent: LATER_EVENT });
    expect(ground()).toEqual({ status: 'grounded', intake: INTAKE });
    expect(ground({ inboundEvent: LATER_EVENT })).toEqual(later);
    if (later.status !== 'grounded') throw new Error('expected grounded');
    expect(later.intake.sourceRequestId).not.toBe(SOURCE);
  });

  it('returns a detached exact four-key intake and no extra outcome keys', () => {
    const first = ground();
    if (first.status !== 'grounded') throw new Error('expected grounded');
    expect(Object.keys(first).sort()).toEqual(['intake', 'status']);
    expect(Object.keys(first.intake).sort()).toEqual([
      'productId',
      'sourceRequestId',
      'type',
      'variantId',
    ]);
    expect(first.intake.type).toBe('EXPIRATION');
    first.intake.variantId = OTHER_VARIANT;
    expect(ground()).toEqual({ status: 'grounded', intake: INTAKE });
  });

  it('ignores model labels and grounds only from validated evidence', () => {
    const outcome = ground({
      candidate: {
        productId: PRODUCT,
        variantId: VARIANT,
        name: 'Nombre del modelo',
      },
    });
    expect(outcome).toEqual({ status: 'grounded', intake: INTAKE });
    expect(JSON.stringify(outcome)).not.toContain('modelo');
  });
});
