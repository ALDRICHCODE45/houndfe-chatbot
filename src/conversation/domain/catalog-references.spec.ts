import {
  CatalogSession,
  catalogSessionSchema,
  type CatalogIdentityEvent,
} from './catalog-references';
import type { AgentMessage } from './conversation-store';

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

  describe('selectionPrompt', () => {
    const canonical = (label: string) =>
      'Para consultar existencias, necesito identificar el producto y su presentación. ' +
      `¿Cuál desea consultar?\n${label}`;

    it('asks a canonical question for a single non-variant candidate', () => {
      const session = seeded();
      session.installSearch(session.beginSearch(), [
        { productId, name: 'Medicine 400 mg', variants: [] },
      ]);
      expect(session.selectionPrompt()).toBe(
        'Para consultar existencias, ¿se refiere a «Medicine 400 mg»?',
      );
    });

    it('asks an explicit bounded choice for multiple candidates without selecting', () => {
      const session = seeded();
      session.installSearch(session.beginSearch(), [
        { productId, name: 'Medicine 400 mg', variants: [] },
        { productId: unknownId, name: 'Medicine 800 mg', variants: [] },
      ]);
      expect(session.selectionPrompt()).toBe(
        canonical('1. Medicine 400 mg\n2. Medicine 800 mg'),
      );
    });

    it('lists every variant and splits same-name variants with option/value', () => {
      const session = seeded();
      session.installSearch(session.beginSearch(), [
        {
          productId,
          name: 'Medicine 400 mg',
          variants: [
            { variantId, name: 'caja', option: 'Tabletas', value: '20' },
            {
              variantId: '00000000-0000-4000-8000-000000000003',
              name: 'caja',
              option: 'Tabletas',
              value: '40',
            },
          ],
        },
      ]);
      expect(session.selectionPrompt()).toBe(
        canonical(
          '1. Medicine 400 mg (caja: Tabletas 20)\n' +
            '2. Medicine 400 mg (caja: Tabletas 40)',
        ),
      );
    });

    it('returns null without a valid snapshot so the caller can fall back', () => {
      const historyless = new CatalogSession(
        'sender',
        100,
        0,
        undefined,
        [],
        () => 1000,
      );
      expect(historyless.selectionPrompt()).toBeNull();
      const snapshot = seeded().snapshot();
      expect(
        new CatalogSession(
          'other',
          100,
          1,
          snapshot,
          history,
          () => 1000,
        ).selectionPrompt(),
      ).toBeNull();
      expect(
        new CatalogSession(
          'sender',
          100,
          1,
          snapshot,
          history,
          () => 1101,
        ).selectionPrompt(),
      ).toBeNull();
    });

    it('returns null instead of truncating ambiguous, excessive or oversized sets', () => {
      const ambiguous = seeded();
      ambiguous.installSearch(ambiguous.beginSearch(), [
        { productId, name: 'Same', variants: [] },
        { productId: unknownId, name: 'Same', variants: [] },
      ]);
      expect(ambiguous.selectionPrompt()).toBeNull();

      const excessive = seeded();
      excessive.installSearch(
        excessive.beginSearch(),
        Array.from({ length: 7 }, (_, index) => ({
          productId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
          name: `Product ${index}`,
          variants: [],
        })),
      );
      expect(excessive.selectionPrompt()).toBeNull();

      const oversized = seeded();
      oversized.installSearch(
        oversized.beginSearch(),
        Array.from({ length: 3 }, (_, index) => ({
          productId: `00000000-0000-4000-8000-${String(index + 200).padStart(12, '0')}`,
          name: String.fromCharCode(0x4e00 + index) + '界'.repeat(255),
          variants: [],
        })),
      );
      expect(oversized.selectionPrompt()).toBeNull();
    });

    it('asks without selecting, inventing ids or claiming stock', () => {
      const session = seeded();
      const prompt = session.selectionPrompt()!;
      expect(prompt).toContain('Medicine 400 mg');
      expect(prompt).not.toContain(productId);
      expect(prompt).not.toContain(variantId);
      expect(prompt).not.toMatch(/disponible|agotado|precio|cantidad/i);
      // Asking is read-only: it never resolves or consumes the session.
      expect(session.matches({ productId })).toBe(true);
      expect(session.evidence(0)).toContain('UNSELECTED');
    });

    it.each<[string, string, string | null]>([
      ['a newline', 'Producto A\n7. Producto falso', null],
      ['a carriage return', 'Producto A\r7. Producto falso', null],
      ['a C0 control', 'Producto A\u0007', null],
      ['a C1 control', 'Producto A\u0085', null],
      ['a line separator', 'Producto A\u2028falso', null],
      ['a paragraph separator', 'Producto A\u2029falso', null],
      ['a bidi format control', 'Producto \u202eA', null],
      ['a variant line break', 'Medicine 400 mg', 'caja\n7. falso'],
    ])('fails closed on a label containing %s', (_label, name, variantName) => {
      const session = seeded();
      session.installSearch(session.beginSearch(), [
        {
          productId,
          name,
          variants:
            variantName === null
              ? []
              : [{ variantId, name: variantName, option: null, value: null }],
        },
      ]);
      expect(session.selectionPrompt()).toBeNull();
    });
  });

  describe('catalog identity diagnostics', () => {
    const observed = (now = 1000) => {
      const events: CatalogIdentityEvent[] = [];
      const session = new CatalogSession(
        'sender',
        100,
        0,
        undefined,
        [],
        () => now,
        (event) => events.push(event),
      );
      return { session, events };
    };
    const latest = (events: CatalogIdentityEvent[]) => events.at(-1);
    const accept = (session: CatalogSession, results: unknown) =>
      session.installSearch(session.beginSearch(), results);

    it('reports the direct install rejection and acceptance branch', () => {
      const { session, events } = observed();
      const stale = session.beginSearch();
      session.beginSearch();
      session.installSearch(stale, [product()]);
      expect(latest(events)).toEqual({
        phase: 'install_search',
        reason: 'stale_ticket',
      });
      for (const [results, reason] of [
        [{}, 'malformed_projection'],
        [Array.from({ length: 21 }, product), 'oversized'],
        [[{ ...product(), name: 'x'.repeat(257) }], 'invalid_snapshot'],
      ] as Array<[unknown, string]>) {
        session.installSearch(session.generation, results);
        expect(latest(events)).toEqual({ phase: 'install_search', reason });
      }
      accept(session, [product()]);
      expect(latest(events)).toEqual({
        phase: 'install_search',
        reason: 'accepted',
      });
    });

    it.each<[string, unknown[], string]>([
      ['duplicate ids', [product(), product()], 'duplicate_id'],
      [
        'the variant limit',
        [
          {
            ...product(),
            variants: Array.from({ length: 100 }, (_, i) => ({
              variantId: `00000000-0000-4000-8000-${String(i + 500).padStart(12, '0')}`,
              name: 'v',
              option: null,
              value: null,
            })),
          },
          {
            productId: unknownId,
            name: 'Second',
            variants: [product().variants[0]],
          },
        ],
        'variant_limit',
      ],
    ])('reports %s directly', (_label, results, reason) => {
      const { session, events } = observed();
      session.installSearch(session.beginSearch(), results);
      expect(latest(events)).toEqual({ phase: 'install_search', reason });
    });

    it('reports each restore rejection and acceptance branch directly', () => {
      const snapshot = seeded().snapshot()!;
      const events: CatalogIdentityEvent[] = [];
      const restore = (
        senderId: string,
        raw: unknown,
        retained: readonly AgentMessage[],
        clock: () => number,
      ) => {
        new CatalogSession(senderId, 100, 1, raw, retained, clock, (event) =>
          events.push(event),
        );
        return latest(events);
      };
      const cases: Array<
        [string, unknown, readonly AgentMessage[], () => number]
      > = [
        ['missing_snapshot', undefined, history, () => 1000],
        ['invalid_snapshot', { bad: true }, history, () => 1000],
        ['sender_mismatch', snapshot, history, () => 1000],
        ['invalid_clock', snapshot, history, () => NaN],
        [
          'future_observation',
          { ...snapshot, observedAt: 2000 },
          history,
          () => 1000,
        ],
        ['expired', snapshot, history, () => 1101],
        ['origin_removed', snapshot, [], () => 1050],
        ['accepted', snapshot, history, () => 1050],
      ];
      for (const [reason, raw, retained, clock] of cases) {
        const senderId = reason === 'sender_mismatch' ? 'other' : 'sender';
        expect(restore(senderId, raw, retained, clock)).toEqual({
          phase: 'restore',
          reason,
        });
      }
    });

    it('reports resolve, expiry, history and silent reads directly', () => {
      const { session, events } = observed();
      accept(session, [product()]);
      events.length = 0;
      for (const [candidate, reason] of [
        [{ productId: unknownId }, 'unknown_product'],
        [{ productId, name: 'Other' }, 'name_mismatch'],
        [{ productId, variantId: unknownId }, 'unknown_variant'],
        [{ productId, variantId }, 'accepted'],
      ] as Array<[Parameters<CatalogSession['resolve']>[0], string]>) {
        session.resolve(candidate);
        expect(latest(events)).toEqual({ phase: 'resolve', reason });
      }

      const silent = observed();
      accept(silent.session, [
        { productId, name: 'Medicine 400 mg', variants: [] },
      ]);
      const before = silent.events.length;
      expect(silent.session.snapshot()).not.toBeNull();
      expect(silent.session.selectionPrompt()).not.toBeNull();
      expect(silent.events).toHaveLength(before);
      expect(silent.session.evidence(1)).toBeNull();
      expect(latest(silent.events)).toEqual({
        phase: 'history',
        reason: 'origin_removed',
      });
      const empty = observed();
      expect(empty.session.evidence(0)).toBeNull();
      expect(latest(empty.events)).toEqual({
        phase: 'history',
        reason: 'missing_snapshot',
      });
    });

    it('reports an expired reference when resolve runs after the TTL', () => {
      let now = 1000;
      const events: CatalogIdentityEvent[] = [];
      const session = new CatalogSession(
        'sender',
        100,
        0,
        undefined,
        [],
        () => now,
        (event) => events.push(event),
      );
      accept(session, [product()]);
      now = 1101;
      expect(session.resolve({ productId })).toBeNull();
      expect(latest(events)).toEqual({ phase: 'resolve', reason: 'expired' });
    });

    it('clears expired references so a rewound clock cannot revive them', () => {
      let now = 1000;
      const events: CatalogIdentityEvent[] = [];
      const session = new CatalogSession(
        'sender',
        100,
        0,
        undefined,
        [],
        () => now,
        (event) => events.push(event),
      );
      session.installSearch(session.beginSearch(), [product()]);
      now = 1101;
      expect(session.evidence(0)).toBeNull();
      expect(latest(events)).toEqual({ phase: 'history', reason: 'expired' });
      now = 1000;
      expect(session.snapshot()).toBeNull();
      expect(session.resolve({ productId })).toBeNull();
      expect(latest(events)?.reason).toBe('missing_snapshot');
    });

    it('never lets a throwing observer change validation results', () => {
      const session = new CatalogSession(
        'sender',
        100,
        0,
        undefined,
        [],
        () => 1000,
        () => {
          throw new Error('boom');
        },
      );
      session.installSearch(session.beginSearch(), [product()]);
      expect(session.snapshot()).not.toBeNull();
      expect(session.resolve({ productId })).not.toBeNull();
      expect(session.evidence(0)).toContain('UNSELECTED');
    });
  });
});
