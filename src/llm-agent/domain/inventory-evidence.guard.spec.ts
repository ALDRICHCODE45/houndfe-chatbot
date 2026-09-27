import {
  InventoryEvidenceGuard,
  isMutatingToolName,
  isNonMutatingToolName,
  isPotentialEffectToolName,
  MUTATING_TOOL_NAMES,
  NON_MUTATING_TOOL_NAMES,
  type InventoryCallEvidence,
} from './inventory-evidence.guard';

const productId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const variantA = '00000000-0000-4000-8000-0000000000aa';
const variantB = '00000000-0000-4000-8000-0000000000bb';

function stock(overrides: Record<string, unknown> = {}) {
  return { status: 'available', quantity: 5, ...overrides };
}

function output(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    productId,
    name: 'Medicine',
    stock: stock(),
    variants: [],
    ...overrides,
  };
}

function checkStock(
  overrides: Partial<InventoryCallEvidence> = {},
): InventoryCallEvidence {
  return {
    toolCallId: 'call-1',
    toolName: 'checkStock',
    input: { productId },
    state: 'result',
    output: output(),
    ...overrides,
  };
}

function variantOutput(
  status: string,
  quantity: unknown,
  variantId = variantA,
) {
  return output({
    stock: { status: 'not_managed', quantity: null },
    variants: [
      {
        variantId,
        name: 'v',
        option: null,
        value: null,
        stock: { status, quantity },
      },
    ],
  });
}

const search: InventoryCallEvidence = {
  toolCallId: 'call-2',
  toolName: 'searchCatalog',
  input: { q: 'Medicine' },
  state: 'result',
  output: { ok: true, results: [] },
};

describe('inventory tool classification', () => {
  it('freezes the seven mutating and six non-mutating names', () => {
    expect([...MUTATING_TOOL_NAMES]).toEqual([
      'evaluateCart',
      'upsertCustomer',
      'createSale',
      'updateDelivery',
      'cancelSale',
      'requestHumanAssistance',
      'getShippingQuote',
    ]);
    expect([...NON_MUTATING_TOOL_NAMES]).toEqual([
      'searchCatalog',
      'checkStock',
      'getCustomerByPhone',
      'getOrderHistory',
      'getPaymentDetails',
      'attachReceipt',
    ]);
  });

  it('classifies known names and fails unknown names closed', () => {
    for (const name of MUTATING_TOOL_NAMES) {
      expect(isMutatingToolName(name)).toBe(true);
      expect(isNonMutatingToolName(name)).toBe(false);
      expect(isPotentialEffectToolName(name)).toBe(true);
    }
    for (const name of NON_MUTATING_TOOL_NAMES) {
      expect(isNonMutatingToolName(name)).toBe(true);
      expect(isMutatingToolName(name)).toBe(false);
      expect(isPotentialEffectToolName(name)).toBe(false);
    }
    expect(isMutatingToolName('mysteryTool')).toBe(false);
    expect(isNonMutatingToolName('mysteryTool')).toBe(false);
    // Any name outside the explicit non-mutating allowlist is a potential effect.
    expect(isPotentialEffectToolName('mysteryTool')).toBe(true);
  });
});

describe('InventoryEvidenceGuard unresolved failures', () => {
  it('keeps a failed check unresolved and never lets search or other tools clear it', () => {
    const guard = new InventoryEvidenceGuard();
    guard.recordStep([checkStock({ state: 'error' })]);
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
    guard.recordStep([search]);
    guard.recordStep([
      {
        toolCallId: 'call-3',
        toolName: 'evaluateCart',
        input: {},
        state: 'result',
        output: { ok: true },
      },
    ]);
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
  });

  it('keeps the failure for the exact subject across any other product', () => {
    const guard = new InventoryEvidenceGuard();
    guard.recordStep([checkStock({ state: 'error' })]);
    guard.recordStep([
      checkStock({
        toolCallId: 'call-4',
        input: { productId: otherId },
        output: output({ productId: otherId }),
      }),
    ]);
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
  });

  it.each([
    [
      'not_managed',
      output({ stock: { status: 'not_managed', quantity: null } }),
    ],
    ['unknown status', output({ stock: { status: 'unknown', quantity: 1 } })],
    ['missing stock', output({ stock: undefined })],
    ['malformed output', null],
    ['ok not true', output({ ok: undefined })],
    ['product mismatch', output({ productId: otherId })],
    [
      'available at zero quantity',
      output({ stock: { status: 'available', quantity: 0 } }),
    ],
    [
      'low_stock at zero quantity',
      output({ stock: { status: 'low_stock', quantity: 0 } }),
    ],
    [
      'out_of_stock at positive quantity',
      output({ stock: { status: 'out_of_stock', quantity: 1 } }),
    ],
    [
      'managed with null quantity',
      output({ stock: { status: 'available', quantity: null } }),
    ],
    [
      'managed with negative quantity',
      output({ stock: { status: 'low_stock', quantity: -1 } }),
    ],
    [
      'managed with fractional quantity',
      output({ stock: { status: 'available', quantity: 1.5 } }),
    ],
  ])(
    'blocks inventory claims from the first non-authoritative %s',
    (_label, result) => {
      const guard = new InventoryEvidenceGuard();
      guard.recordStep([checkStock({ toolCallId: 'call-5', output: result })]);
      expect(guard.hasUnresolvedStockFailure()).toBe(true);
    },
  );

  it.each([
    ['available', { status: 'available', quantity: 1 }],
    ['low_stock', { status: 'low_stock', quantity: 2 }],
    ['out_of_stock', { status: 'out_of_stock', quantity: 0 }],
  ])(
    'clears a same-subject failure on an authoritative %s result',
    (_label, stockValue) => {
      const guard = new InventoryEvidenceGuard();
      guard.recordStep([checkStock({ state: 'error' })]);
      guard.recordStep([
        checkStock({
          toolCallId: 'call-6',
          output: output({ stock: stockValue }),
        }),
      ]);
      expect(guard.hasUnresolvedStockFailure()).toBe(false);
    },
  );

  it('requires a unique matching variant with a consistent authoritative status', () => {
    const guard = new InventoryEvidenceGuard();
    guard.recordStep([
      checkStock({ state: 'error', input: { productId, variantId: variantA } }),
    ]);
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
    // Only a different variant is present: the requested subject is unproven.
    guard.recordStep([
      checkStock({
        toolCallId: 'v1',
        input: { productId, variantId: variantA },
        output: variantOutput('out_of_stock', 0, variantB),
      }),
    ]);
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
    // Matching variant but inconsistent quantity.
    guard.recordStep([
      checkStock({
        toolCallId: 'v2',
        input: { productId, variantId: variantA },
        output: variantOutput('available', 0, variantA),
      }),
    ]);
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
    // Duplicate matching variants are ambiguous.
    guard.recordStep([
      checkStock({
        toolCallId: 'v3',
        input: { productId, variantId: variantA },
        output: output({
          stock: { status: 'not_managed', quantity: null },
          variants: [
            {
              variantId: variantA,
              name: 'v',
              option: null,
              value: null,
              stock: { status: 'out_of_stock', quantity: 0 },
            },
            {
              variantId: variantA,
              name: 'v',
              option: null,
              value: null,
              stock: { status: 'available', quantity: 1 },
            },
          ],
        }),
      }),
    ]);
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
    // A single matching variant with a consistent status clears.
    guard.recordStep([
      checkStock({
        toolCallId: 'v4',
        input: { productId, variantId: variantA },
        output: variantOutput('out_of_stock', 0, variantA),
      }),
    ]);
    expect(guard.hasUnresolvedStockFailure()).toBe(false);
  });

  it('lets any same-step untrustworthy result dominate a success in either order', () => {
    const bad = checkStock({ toolCallId: 'bad', output: null });
    const good = checkStock({ toolCallId: 'ok' });
    for (const calls of [
      [good, bad],
      [bad, good],
    ]) {
      const guard = new InventoryEvidenceGuard();
      guard.recordStep(calls);
      expect(guard.hasUnresolvedStockFailure()).toBe(true);
    }
  });

  it('lets a same-step error dominate a same-step success', () => {
    const forward = new InventoryEvidenceGuard();
    forward.recordStep([
      checkStock({ toolCallId: 'ok' }),
      checkStock({ toolCallId: 'fail', state: 'error' }),
    ]);
    expect(forward.hasUnresolvedStockFailure()).toBe(true);
    const reversed = new InventoryEvidenceGuard();
    reversed.recordStep([
      checkStock({ toolCallId: 'fail', state: 'error' }),
      checkStock({ toolCallId: 'ok' }),
    ]);
    expect(reversed.hasUnresolvedStockFailure()).toBe(true);
  });

  it('treats a denied or unaccounted stock check as no authoritative proof', () => {
    for (const state of ['denied', 'unaccounted'] as const) {
      const guard = new InventoryEvidenceGuard();
      guard.recordStep([checkStock({ state })]);
      expect(guard.hasUnresolvedStockFailure()).toBe(true);
    }
  });

  it('clears a prior failure with a later same-step success', () => {
    const guard = new InventoryEvidenceGuard();
    guard.recordStep([checkStock({ state: 'error' })]);
    guard.recordStep([checkStock({ toolCallId: 'call-10' })]);
    expect(guard.hasUnresolvedStockFailure()).toBe(false);
  });

  it('is order independent for parallel subjects in one step', () => {
    const first = new InventoryEvidenceGuard();
    const second = new InventoryEvidenceGuard();
    const a = checkStock({ toolCallId: 'a', state: 'error' });
    const b = checkStock({
      toolCallId: 'b',
      input: { productId: otherId },
      state: 'error',
    });
    const clearA = checkStock({ toolCallId: 'a-ok' });
    const clearB = checkStock({
      toolCallId: 'b-ok',
      input: { productId: otherId },
      output: output({ productId: otherId }),
    });
    first.recordStep([a, b]);
    first.recordStep([clearB, clearA]);
    second.recordStep([b, a]);
    second.recordStep([clearA, clearB]);
    expect(first.hasUnresolvedStockFailure()).toBe(false);
    expect(second.hasUnresolvedStockFailure()).toBe(false);
  });
});

describe('InventoryEvidenceGuard executed mutations', () => {
  const cases: Array<[string, InventoryCallEvidence, boolean]> = [
    [
      'a known mutation result',
      { toolCallId: 'e1', toolName: 'createSale', input: {}, state: 'result' },
      true,
    ],
    [
      'an ambiguous known mutation error',
      {
        toolCallId: 'e2',
        toolName: 'updateDelivery',
        input: {},
        state: 'error',
      },
      true,
    ],
    [
      'an unknown executed result',
      { toolCallId: 'e3', toolName: 'mysteryTool', input: {}, state: 'result' },
      true,
    ],
    [
      'an unknown executed error',
      { toolCallId: 'e4', toolName: 'mysteryTool', input: {}, state: 'error' },
      true,
    ],
    [
      'an unknown unaccounted call',
      {
        toolCallId: 'e5',
        toolName: 'mysteryTool',
        input: {},
        state: 'unaccounted',
      },
      true,
    ],
    [
      'a denied known mutation',
      { toolCallId: 'e6', toolName: 'createSale', input: {}, state: 'denied' },
      false,
    ],
    [
      'a denied unknown tool',
      { toolCallId: 'e7', toolName: 'mysteryTool', input: {}, state: 'denied' },
      false,
    ],
    ['an executed read-only tool', search, false],
  ];

  it.each(cases)(
    'treats %s as executedMutation=%s',
    (_label, call, expected) => {
      const guard = new InventoryEvidenceGuard();
      guard.recordStep([call]);
      expect(guard.hasExecutedMutation()).toBe(expected);
    },
  );

  it('tolerates malformed step payloads without throwing', () => {
    const guard = new InventoryEvidenceGuard();
    guard.recordStep(undefined as never);
    guard.recordStep([
      null as never,
      42 as never,
      { toolName: 'checkStock' } as never,
    ]);
    // An unaccounted checkStock call is a failure (conservative, no proof).
    expect(guard.hasUnresolvedStockFailure()).toBe(true);
  });
});
