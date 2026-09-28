import { CatalogSession, catalogSessionSchema } from './catalog-references';

const productId = '00000000-0000-4000-8000-000000000001';
const variantId = '00000000-0000-4000-8000-000000000002';
const unknownId = '00000000-0000-4000-8000-0000000000ff';
const product = () => ({
  productId,
  name: 'Medicine 400 mg',
  variants: [{ variantId, name: '20 tablets', option: 'Package', value: '20' }],
});
const history = [{ role: 'user' as const, content: 'Medicine' }];
function seeded(now = 1000) {
  const session = new CatalogSession(
    'sender',
    100,
    0,
    undefined,
    [],
    () => now,
  );
  session.installSearch(session.beginSearch(), [product()]);
  return session;
}

describe('CatalogSession', () => {
  it('rejects prototype forgeries and proxies as runtime context', () => {
    const forged: unknown = Object.create(CatalogSession.prototype);
    const proxy = new Proxy(seeded(), {});
    expect(catalogSessionSchema.safeParse(forged).success).toBe(false);
    expect(catalogSessionSchema.safeParse(proxy).success).toBe(false);
    expect(
      catalogSessionSchema.safeParse({ matches: () => true }).success,
    ).toBe(false);
    expect(catalogSessionSchema.safeParse(seeded()).success).toBe(true);
  });

  it('detaches both input and output while projecting identity only', () => {
    const session = seeded();
    const snapshot = session.snapshot()!;
    const restored = new CatalogSession(
      'sender',
      100,
      1,
      snapshot,
      history,
      () => 1050,
    );
    snapshot.products[0].name = 'Changed';
    expect(restored.matches({ productId, name: 'Medicine 400 mg' })).toBe(true);
    restored.snapshot()!.products[0].variants[0].value = 'changed';
    expect(restored.snapshot()!.products[0].variants[0].value).toBe('20');
    const raw = {
      ...product(),
      stock: { quantity: 50 },
      description: 'private',
      price: 1,
    };
    session.installSearch(session.beginSearch(), [raw]);
    expect(session.snapshot()!.products).toEqual([product()]);
  });

  it('keeps original observation time and expires without sliding renewal', () => {
    const snapshot = seeded().snapshot();
    const restored = new CatalogSession(
      'sender',
      100,
      1,
      snapshot,
      history,
      () => 1090,
    );
    expect(restored.snapshot()!.observedAt).toBe(1000);
    const expired = new CatalogSession(
      'sender',
      100,
      2,
      restored.snapshot(),
      history,
      () => 1101,
    );
    expect(expired.matches({ productId })).toBe(false);
  });

  it.each([NaN, Infinity, -1, 1100])(
    'rejects invalid or future observation %s',
    (observedAt) => {
      const snapshot = { ...seeded().snapshot(), observedAt };
      expect(
        new CatalogSession(
          'sender',
          100,
          1,
          snapshot,
          history,
          () => 1000,
        ).snapshot(),
      ).toBeNull();
    },
  );

  it('rejects another sender and missing original user provenance', () => {
    const snapshot = seeded().snapshot();
    expect(
      new CatalogSession(
        'other',
        100,
        1,
        snapshot,
        history,
        () => 1000,
      ).snapshot(),
    ).toBeNull();
    expect(
      new CatalogSession('sender', 100, 1, snapshot, [], () => 1000).snapshot(),
    ).toBeNull();
    expect(
      new CatalogSession(
        'sender',
        100,
        1,
        snapshot,
        [{ role: 'assistant', content: 'Medicine' }],
        () => 1000,
      ).snapshot(),
    ).toBeNull();
  });

  it('removes evidence when its origin leaves the prompt and never resurrects it', () => {
    const session = seeded();
    expect(session.evidence(0)).toContain('UNSELECTED');
    expect(session.evidence(1)).toBeNull();
    expect(session.evidence(0)).toBeNull();
    expect(session.snapshot()).toBeNull();
  });

  it('clears candidates at search start and only latest-started search may install', () => {
    const session = seeded();
    const old = session.beginSearch();
    expect(session.matches({ productId })).toBe(false);
    const latest = session.beginSearch();
    session.installSearch(old, [product()]);
    expect(session.snapshot()).toBeNull();
    session.installSearch(latest, [product()]);
    expect(session.matches({ productId })).toBe(true);
    const empty = session.beginSearch();
    session.installSearch(empty, []);
    session.installSearch(old, [product()]);
    expect(session.snapshot()).toBeNull();
  });

  it.each([
    [null],
    [{ ...product(), name: 'x'.repeat(257) }],
    [
      {
        ...product(),
        variants: [{ ...product().variants[0], value: 'x'.repeat(129) }],
      },
    ],
    [product(), product()],
    [
      {
        ...product(),
        variants: [product().variants[0], product().variants[0]],
      },
    ],
    Array.from({ length: 21 }, product),
    [
      {
        ...product(),
        variants: Array.from({ length: 101 }, () => product().variants[0]),
      },
    ],
  ])('rejects malformed, conflicting or oversized results %#', (...results) => {
    const session = seeded();
    session.installSearch(session.beginSearch(), results);
    expect(session.snapshot()).toBeNull();
  });

  it('enforces total variant and serialized-byte bounds without truncation', () => {
    const variants = Array.from({ length: 100 }, (_, index) => ({
      variantId: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, '0')}`,
      name: '界'.repeat(256),
      option: '界'.repeat(128),
      value: '界'.repeat(128),
    }));
    const session = seeded();
    session.installSearch(session.beginSearch(), [{ ...product(), variants }]);
    expect(session.snapshot()).toBeNull();
    const small = variants.map((variant) => ({
      ...variant,
      name: 'small',
      option: null,
      value: null,
    }));
    session.installSearch(session.beginSearch(), [
      { ...product(), variants: small },
    ]);
    expect(session.snapshot()!.products[0].variants).toHaveLength(100);
    session.installSearch(session.beginSearch(), [
      { ...product(), variants: small },
      {
        productId: '00000000-0000-4000-8000-000000000010',
        name: 'Second',
        variants: [product().variants[0]],
      },
    ]);
    expect(session.snapshot()).toBeNull();
  });

  it('rejects hostile accessors without retaining previous evidence', () => {
    const session = seeded();
    session.installSearch(session.beginSearch(), [
      {
        get productId() {
          throw new Error('hostile');
        },
      },
    ]);
    expect(session.snapshot()).toBeNull();
  });

  it('exposes a monotonic read-only generation that increments before installation', () => {
    const session = new CatalogSession(
      'sender',
      100,
      0,
      undefined,
      [],
      () => 1000,
    );
    expect(session.generation).toBe(0);
    const first = session.beginSearch();
    expect(first).toBe(1);
    expect(session.generation).toBe(1);
    session.installSearch(first, [product()]);
    expect(session.generation).toBe(1);
    const second = session.beginSearch();
    expect(second).toBe(2);
    expect(session.generation).toBe(2);
    session.installSearch(first, [product()]);
    expect(session.snapshot()).toBeNull();
    expect(session.generation).toBe(2);
  });

  it('resolves a detached canonical product subject from validated references only', () => {
    const session = seeded();
    const resolved = session.resolve({ productId });
    expect(resolved).toEqual({
      productId,
      productName: 'Medicine 400 mg',
      variantId: null,
      variantName: null,
    });
    resolved!.productName = 'Mutated';
    expect(session.resolve({ productId })!.productName).toBe('Medicine 400 mg');
    expect(session.resolve({ productId: unknownId })).toBeNull();
    expect(session.resolve({ productId, name: 'Other' })).toBeNull();
  });

  it('resolves a canonical variant subject with catalog names', () => {
    const session = seeded();
    expect(session.resolve({ productId, variantId })).toEqual({
      productId,
      productName: 'Medicine 400 mg',
      variantId,
      variantName: '20 tablets',
    });
    expect(session.resolve({ productId, variantId: unknownId })).toBeNull();
  });

  it('keeps matches parity with resolve across candidate shapes', () => {
    const session = seeded();
    const cases: Array<{
      productId: string;
      variantId?: string | null;
      name?: string;
    }> = [
      { productId },
      { productId, name: 'Medicine 400 mg' },
      { productId, name: 'Other' },
      { productId, variantId },
      { productId, variantId: unknownId },
      { productId: unknownId },
    ];
    for (const candidate of cases) {
      expect(session.matches(candidate)).toBe(
        session.resolve(candidate) !== null,
      );
    }
    expect(session.matches({ productId, variantId })).toBe(true);
    expect(session.matches({ productId: unknownId })).toBe(false);
  });

  it('drops the canonical subject once the reference TTL has elapsed', () => {
    let now = 1000;
    const session = new CatalogSession(
      'sender',
      100,
      0,
      undefined,
      [],
      () => now,
    );
    session.installSearch(session.beginSearch(), [product()]);
    expect(session.resolve({ productId })).not.toBeNull();
    now = 1101;
    expect(session.resolve({ productId })).toBeNull();
    expect(session.matches({ productId })).toBe(false);
  });
});
