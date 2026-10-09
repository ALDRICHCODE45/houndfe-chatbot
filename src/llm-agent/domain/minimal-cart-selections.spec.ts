import {
  MinimalCartSelections,
  type MinimalCartSelectionIdentity,
  type MinimalCartSelectionSnapshot,
} from './minimal-cart-selections';

const productId = '00000000-0000-4000-8000-000000000001';
const otherProductId = '00000000-0000-4000-8000-000000000002';
const variant400 = '00000000-0000-4000-8000-0000000000aa';
const variant500 = '00000000-0000-4000-8000-0000000000bb';
const upperProductId = '00000000-0000-4000-8000-00000000000A';
const upperVariantId = '00000000-0000-4000-8000-0000000000B0';
const invented = '00000000-0000-4000-8000-000000000099';

const ibuprofen400: MinimalCartSelectionIdentity = {
  productId,
  variantId: variant400,
  productName: 'Ibuprofeno',
  variantName: '400 mg',
};
const ibuprofen500: MinimalCartSelectionIdentity = {
  productId,
  variantId: variant500,
  productName: 'Ibuprofeno',
  variantName: '500 mg',
};
const simpleProduct: MinimalCartSelectionIdentity = {
  productId: otherProductId,
  productName: 'Croquetas Nupec',
};

function mustReference(value: string | null): string {
  if (value === null) throw new Error('expected a reference');
  return value;
}

function mustResolve(
  selections: MinimalCartSelections,
  reference: string,
): MinimalCartSelectionIdentity & { reference: string } {
  const resolved = selections.resolve(reference);
  if (resolved === null) throw new Error('expected resolved selection');
  return resolved;
}

describe('MinimalCartSelections opaque references (S1, S6)', () => {
  it('returns a stable opaque non-identity reference for the exact pair', () => {
    const selections = new MinimalCartSelections('sender-1');
    const first = mustReference(selections.register(ibuprofen500));
    const second = mustReference(selections.register(ibuprofen500));
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    // The reference is never a product/variant URL or a concatenated UUID.
    expect(first).not.toContain(productId);
    expect(first).not.toContain(variant500);
  });

  it('gives distinct references to the same product with distinct variants', () => {
    const selections = new MinimalCartSelections('sender-1');
    const ref400 = mustReference(selections.register(ibuprofen400));
    const ref500 = mustReference(selections.register(ibuprofen500));
    expect(ref400).not.toBe(ref500);
  });

  it('updates labels on repeat registration without creating a new entry', () => {
    const selections = new MinimalCartSelections('sender-1');
    const reference = mustReference(selections.register(ibuprofen500));
    const renamed = mustReference(
      selections.register({ ...ibuprofen500, variantName: '500 mg caja' }),
    );
    expect(renamed).toBe(reference);
    const snapshot = selections.snapshot();
    expect(snapshot.selections).toHaveLength(1);
    expect(snapshot.selections[0]).toEqual({
      ...ibuprofen500,
      variantName: '500 mg caja',
      reference,
    });
  });
});

describe('MinimalCartSelections verified binding only (S1, S4)', () => {
  it('binds the 500 mg presentation to its verified pair fixture', () => {
    const selections = new MinimalCartSelections('sender-1');
    const reference = mustReference(selections.register(ibuprofen500));
    expect(selections.resolve(reference)).toEqual({
      productId,
      variantId: variant500,
      productName: 'Ibuprofeno',
      variantName: '500 mg',
      reference,
    });
  });

  it('preserves an uppercase UUID identity byte-for-byte (S4)', () => {
    const selections = new MinimalCartSelections('sender-1');
    const identity: MinimalCartSelectionIdentity = {
      productId: upperProductId,
      variantId: upperVariantId,
      productName: 'Ibuprofeno',
      variantName: '500 mg',
    };
    const reference = mustReference(selections.register(identity));
    expect(selections.resolve(reference)).toEqual({ ...identity, reference });
    expect(selections.snapshot().selections).toEqual([
      { ...identity, reference },
    ]);
  });

  it('keeps simple-product and variant bindings independent', () => {
    const selections = new MinimalCartSelections('sender-1');
    const simpleRef = mustReference(selections.register(simpleProduct));
    const variantRef = mustReference(selections.register(ibuprofen500));
    expect(simpleRef).not.toBe(variantRef);
    expect(selections.resolve(simpleRef)).toEqual({
      productId: otherProductId,
      productName: 'Croquetas Nupec',
      reference: simpleRef,
    });
    expect(selections.resolve(variantRef)).toMatchObject({
      productId,
      variantId: variant500,
    });
  });

  it('never picks a variant from a repeated name when the ids differ', () => {
    const selections = new MinimalCartSelections('sender-1');
    const first = mustReference(
      selections.register({
        productId: otherProductId,
        variantId: variant400,
        productName: 'Ibuprofeno',
        variantName: '500 mg',
      }),
    );
    const second = mustReference(
      selections.register({
        productId: otherProductId,
        variantId: variant500,
        productName: 'Ibuprofeno',
        variantName: '500 mg',
      }),
    );
    expect(first).not.toBe(second);
    expect(selections.resolve(first)).toMatchObject({ variantId: variant400 });
    expect(selections.resolve(second)).toMatchObject({ variantId: variant500 });
  });

  it('leaves other saved lines untouched when a presentation is added (S1)', () => {
    const selections = new MinimalCartSelections('sender-1');
    const ref400 = mustReference(selections.register(ibuprofen400));
    const before = selections.resolve(ref400);
    mustReference(selections.register(ibuprofen500));
    expect(selections.snapshot().selections).toHaveLength(2);
    expect(selections.resolve(ref400)).toEqual(before);
  });

  it('rejects an unknown or invented reference without decoding it (S4)', () => {
    const selections = new MinimalCartSelections('sender-1');
    const reference = mustReference(selections.register(ibuprofen500));
    expect(selections.resolve(invented)).toBeNull();
    expect(selections.resolve(productId)).toBeNull();
    expect(selections.resolve(variant500)).toBeNull();
    expect(selections.resolve('')).toBeNull();
    expect(selections.resolve(reference.toUpperCase())).toBeNull();
    expect(selections.resolve(null as unknown as string)).toBeNull();
  });
});

describe('MinimalCartSelections identity validation (S1, S4, S6)', () => {
  it.each([
    ['a malformed product id', { ...ibuprofen500, productId: 'not-a-uuid' }],
    ['a malformed variant id', { ...ibuprofen500, variantId: 'nope' }],
    [
      'a UUID with an invalid version',
      { ...ibuprofen500, productId: '00000000-0000-9000-8000-000000000001' },
    ],
    [
      'a UUID with an invalid variant field',
      { ...ibuprofen500, variantId: '00000000-0000-4000-c000-000000000001' },
    ],
    ['an empty product label', { productId, productName: '' }],
    ['a whitespace-only product label', { productId, productName: '   ' }],
    [
      'a product label with a breaking character',
      { productId, productName: 'Ibu\u202eprofeno' },
    ],
    [
      'a variant name without a variant id',
      { productId, productName: 'Ibuprofeno', variantName: '500 mg' },
    ],
    ['a non-object identity', null],
    ['an array identity', []],
  ])('rejects %s and keeps the prior snapshot intact', (_label, candidate) => {
    const selections = new MinimalCartSelections('sender-1');
    const reference = mustReference(selections.register(ibuprofen500));
    expect(selections.register(candidate as never)).toBeNull();
    expect(selections.snapshot().selections).toEqual([
      { ...ibuprofen500, reference },
    ]);
    expect(selections.resolve(reference)).not.toBeNull();
  });
});

describe('MinimalCartSelections sender isolation and snapshots (S1, S6)', () => {
  it('starts empty and resolves nothing without a snapshot', () => {
    const selections = new MinimalCartSelections('sender-1');
    expect(selections.snapshot()).toEqual({
      senderId: 'sender-1',
      selections: [],
    });
    expect(selections.resolve(invented)).toBeNull();
  });

  it('never imports a snapshot belonging to another sender', () => {
    const source = new MinimalCartSelections('sender-1');
    const reference = mustReference(source.register(ibuprofen500));
    const restored = new MinimalCartSelections('sender-2', source.snapshot());
    expect(restored.snapshot()).toEqual({
      senderId: 'sender-2',
      selections: [],
    });
    expect(restored.resolve(reference)).toBeNull();
  });

  it('restores its own snapshot round-trip with the same references', () => {
    const source = new MinimalCartSelections('sender-1');
    const reference = mustReference(source.register(ibuprofen500));
    const restored = new MinimalCartSelections('sender-1', source.snapshot());
    expect(restored.resolve(reference)).toEqual({
      ...ibuprofen500,
      reference,
    });
  });

  it('rejects a forged snapshot reference that it could not have derived', () => {
    const forged: MinimalCartSelectionSnapshot = {
      senderId: 'sender-1',
      selections: [{ ...ibuprofen500, reference: 'deadbeefdeadbeef' }],
    };
    const selections = new MinimalCartSelections('sender-1', forged);
    expect(selections.snapshot().selections).toEqual([]);
    expect(selections.resolve('deadbeefdeadbeef')).toBeNull();
  });

  it('does not mutate internal bindings through returned snapshot or resolves', () => {
    const selections = new MinimalCartSelections('sender-1');
    const reference = mustReference(selections.register(ibuprofen500));
    const snapshot = selections.snapshot();
    snapshot.selections[0].productName = 'tampered';
    snapshot.selections.push({ ...ibuprofen400, reference: 'forged' });
    const resolved = mustResolve(selections, reference);
    resolved.productName = 'tampered-again';
    resolved.reference = 'forged-again';
    expect(selections.snapshot()).toEqual({
      senderId: 'sender-1',
      selections: [{ ...ibuprofen500, reference }],
    });
    expect(selections.resolve(reference)).toEqual({
      ...ibuprofen500,
      reference,
    });
  });

  it('ignores post-construction mutation of the supplied snapshot', () => {
    const source = new MinimalCartSelections('sender-1');
    const reference = mustReference(source.register(ibuprofen500));
    const snapshot = source.snapshot();
    const restored = new MinimalCartSelections('sender-1', snapshot);
    snapshot.selections[0].productName = 'tampered';
    expect(restored.resolve(reference)).toEqual({
      ...ibuprofen500,
      reference,
    });
  });
});
