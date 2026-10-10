import {
  groundCartQuantity,
  type CartQuantityEvidenceInput,
  type MinimalCartQuantityIntent,
} from './minimal-cart-quantity';

const productId = '00000000-0000-4000-8000-000000000001';
const otherProductId = '00000000-0000-4000-8000-000000000002';

/**
 * Optional server-trusted identity labels the caller supplies from a verified
 * selection. Kept as a local extension while the pure helper's public input
 * type is extended to accept them (S4 named whole-line removal).
 */
type TrustedIdentityLabels = {
  productName?: string | null;
  variantName?: string | null;
};

function input(
  overrides: Partial<CartQuantityEvidenceInput> & TrustedIdentityLabels,
): CartQuantityEvidenceInput {
  return {
    text: '',
    productId,
    operation: 'add',
    quantity: null,
    quantityText: null,
    continuation: false,
    ...overrides,
  };
}

describe('groundCartQuantity pending quantity policy (S3)', () => {
  it('keeps the two units stated earlier when the 500mg continuation cites no count', () => {
    const first = groundCartQuantity(
      input({
        text: 'Agrega 2 ibuprofenos',
        operation: 'add',
        quantity: 2,
        quantityText: '2',
      }),
    );
    expect(first).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 2 },
    });
    if (first.kind !== 'ready') throw new Error('expected ready');

    const second = groundCartQuantity(
      input({
        text: 'Los de 500mg',
        operation: 'add',
        quantity: null,
        quantityText: null,
        pending: first.intent,
        continuation: true,
      }),
    );
    expect(second).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 2 },
    });
  });

  it('lets a fresh explicit quantity supersede the pending quantity', () => {
    const pending: MinimalCartQuantityIntent = {
      productId,
      operation: 'add',
      quantity: 2,
    };
    const result = groundCartQuantity(
      input({
        text: 'Agrega 3 ibuprofenos',
        operation: 'add',
        quantity: 3,
        quantityText: '3',
        pending,
        continuation: true,
      }),
    );
    expect(result).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 3 },
    });
  });

  it('never carries a pending quantity across products', () => {
    const pending: MinimalCartQuantityIntent = {
      productId,
      operation: 'add',
      quantity: 2,
    };
    const result = groundCartQuantity(
      input({
        text: 'Los de 500mg',
        productId: otherProductId,
        operation: 'add',
        pending,
        continuation: true,
      }),
    );
    expect(result).toEqual({
      kind: 'quantity_required',
      intent: { productId: otherProductId, operation: 'add' },
    });
  });

  it('never carries into a new request when continuation is false', () => {
    const pending: MinimalCartQuantityIntent = {
      productId,
      operation: 'add',
      quantity: 2,
    };
    const result = groundCartQuantity(
      input({
        text: 'Agrega ibuprofeno',
        operation: 'add',
        pending,
        continuation: false,
      }),
    );
    expect(result).toEqual({
      kind: 'quantity_required',
      intent: { productId, operation: 'add' },
    });
  });

  it('never carries a pending quantity across incompatible operations', () => {
    const pending: MinimalCartQuantityIntent = {
      productId,
      operation: 'add',
      quantity: 2,
    };
    const result = groundCartQuantity(
      input({
        text: 'Los de 500mg',
        operation: 'set',
        pending,
        continuation: true,
      }),
    );
    expect(result).toEqual({
      kind: 'quantity_required',
      intent: { productId, operation: 'set' },
    });
  });
});

describe('groundCartQuantity missing quantity asks (S2)', () => {
  it('asks for quantity when the final selection never stated one', () => {
    const result = groundCartQuantity(
      input({
        text: 'Si, la de 500mg por favor.',
        operation: 'add',
        continuation: true,
      }),
    );
    expect(result).toEqual({
      kind: 'quantity_required',
      intent: { productId, operation: 'add' },
    });
    if (result.kind !== 'quantity_required')
      throw new Error('expected quantity_required');
    expect('quantity' in result.intent).toBe(false);
  });
});

describe('groundCartQuantity explicit evidence (S4)', () => {
  it('accepts a Spanish count word', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega una unidad de Croquetas Nupec',
          quantity: 1,
          quantityText: 'una',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 1 },
    });
  });

  it('accepts a cited digit count', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega 5 unidades de croquetas nupec',
          quantity: 5,
          quantityText: '5',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 5 },
    });
  });

  it('accepts a set that fixes the total and does not increment on repeat', () => {
    const first = groundCartQuantity(
      input({
        text: 'Dejame solo una unidad de croquetas por favor.',
        operation: 'set',
        quantity: 1,
        quantityText: 'una',
      }),
    );
    expect(first).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'set', quantity: 1 },
    });

    const repeat = groundCartQuantity(
      input({
        text: 'Dejame solo una unidad de croquetas por favor.',
        operation: 'set',
        quantity: 1,
        quantityText: 'una',
        pending: { productId, operation: 'set', quantity: 1 },
        continuation: true,
      }),
    );
    expect(repeat).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'set', quantity: 1 },
    });
  });

  it('accepts a subtract of one unit', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita una unidad de croquetas',
          operation: 'subtract',
          quantity: 1,
          quantityText: 'una',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'subtract', quantity: 1 },
    });
  });

  it('treats remove as a whole-line operation that needs no count', () => {
    expect(
      groundCartQuantity(
        input({ text: 'Quita el producto', operation: 'remove' }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'remove', quantity: 0 },
    });
    expect(
      groundCartQuantity(
        input({ text: 'Quita el producto', operation: 'remove', quantity: 0 }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'remove', quantity: 0 },
    });
  });

  it('maps clear Spanish count words up to diez', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega dos unidades',
          quantity: 2,
          quantityText: 'dos',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 2 },
    });
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega diez unidades',
          quantity: 10,
          quantityText: 'diez',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 10 },
    });
  });
});

describe('groundCartQuantity fails closed on unverifiable evidence', () => {
  it('rejects a quote that is not present in the current text', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega dos ibuprofenos',
          quantity: 5,
          quantityText: '5',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('rejects a dosage as a count and a substring of a dosage', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega ibuprofeno 500mg',
          quantity: 500,
          quantityText: '500',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega ibuprofeno 500mg',
          quantity: 5,
          quantityText: '5',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega ibuprofeno 500mg',
          quantity: 500,
          quantityText: '500mg',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('rejects an explicit number with no cited span', () => {
    expect(
      groundCartQuantity(input({ text: 'Agrega ibuprofeno', quantity: 2 })),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('rejects a citation whose parsed count disagrees with the model number', () => {
    expect(
      groundCartQuantity(
        input({ text: 'Agrega 3 ibuprofenos', quantity: 2, quantityText: '3' }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('rejects conflicting counts inside the cited span', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega 2 o 3 ibuprofenos',
          quantity: 2,
          quantityText: '2 o 3',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('rejects a negative count and a zero count for add', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega -2 ibuprofenos',
          quantity: -2,
          quantityText: '-2',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
    expect(
      groundCartQuantity(
        input({ text: 'Agrega 0 ibuprofenos', quantity: 0, quantityText: '0' }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('matches quotes case- and diacritic-insensitively on whole words', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'AGREGA DOS ibuprofenos',
          quantity: 2,
          quantityText: 'DOS',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 2 },
    });
  });

  it('rejects a set operation when the current text clearly asks to add', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega 5 unidades de croquetas',
          operation: 'set',
          quantity: 5,
          quantityText: '5',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('rejects a malformed operation at runtime', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega 2 ibuprofenos',
          operation: 'agregar' as never,
          quantity: 2,
          quantityText: '2',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });
});

describe('groundCartQuantity S2/S4 citation and removal corrections', () => {
  it('rejects a standalone dosage count cited out of its 500 mg context (S2)', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Si, la de 500 mg por favor.',
          operation: 'add',
          quantity: 500,
          quantityText: '500',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
    expect(
      groundCartQuantity(
        input({
          text: 'Si, la de 500 mg por favor.',
          operation: 'set',
          quantity: 0,
          quantityText: null,
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('rejects a model-only whole-line clear with no removal evidence (S2)', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Si, la de 500 mg por favor.',
          operation: 'remove',
          quantity: null,
          quantityText: null,
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('keeps a valid literal two and carries two across a 500 mg continuation (S3)', () => {
    const first = groundCartQuantity(
      input({
        text: 'Agrega 2 ibuprofenos de 500 mg',
        operation: 'add',
        quantity: 2,
        quantityText: '2',
      }),
    );
    expect(first).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 2 },
    });
    if (first.kind !== 'ready') throw new Error('expected ready');

    const second = groundCartQuantity(
      input({
        text: 'Los de 500 mg',
        operation: 'add',
        quantity: null,
        quantityText: null,
        pending: first.intent,
        continuation: true,
      }),
    );
    expect(second).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 2 },
    });
  });

  it('requires a cited zero for a set clear (S4)', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Dejame 0 croquetas',
          operation: 'set',
          quantity: 0,
          quantityText: '0',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'set', quantity: 0 },
    });
    expect(
      groundCartQuantity(
        input({
          text: 'Dejame sin croquetas',
          operation: 'set',
          quantity: 0,
          quantityText: null,
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('does not treat a partial cut as a whole-line remove (S4)', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita una unidad de croquetas',
          operation: 'remove',
          quantity: null,
          quantityText: null,
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it("does not let a generic 'solo' whitewash a set over an add verb (S4)", () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega solo 2 unidades',
          operation: 'set',
          quantity: 2,
          quantityText: '2',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });
});

describe('groundCartQuantity singular "otra unidad" evidence (S4)', () => {
  it('accepts the full phrase "otra unidad" as one grounded unit', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega otra unidad de Croquetas Nupec',
          quantity: 1,
          quantityText: 'otra unidad',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 1 },
    });
  });

  it('accepts a bare "otra" citation only when the real text proves singular unidad', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quiero que agregues otra unidad de croquetas nupec',
          quantity: 1,
          quantityText: 'otra',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'add', quantity: 1 },
    });
  });

  it('does not read "otra presentación" as one unit', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega otra presentación de croquetas',
          quantity: 1,
          quantityText: 'otra',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('does not guess one from a bare plural "otras unidades"', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega otras unidades de croquetas',
          quantity: 1,
          quantityText: 'otras',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega otras unidades de croquetas',
          quantity: 1,
          quantityText: 'otras unidades',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('fails closed when the contextual "otra unidad" evidence repeats', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega otra unidad de croquetas y otra unidad de ibuprofeno',
          quantity: 1,
          quantityText: 'otra',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega otra unidad de croquetas y otra presentación de ibuprofeno',
          quantity: 1,
          quantityText: 'otra',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('does not clear a whole line from a partial "otra unidad" removal', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita otra unidad de croquetas nupec',
          operation: 'remove',
          quantity: null,
          quantityText: null,
          productName: 'Croquetas Nupec',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('subtracts one unit from a partial "otra unidad" removal', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita otra unidad de croquetas nupec',
          operation: 'subtract',
          quantity: 1,
          quantityText: 'otra unidad',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'subtract', quantity: 1 },
    });
  });

  it('rejects a set total of one on both reported add phrases', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Agrega otra unidad de Croquetas Nupec',
          operation: 'set',
          quantity: 1,
          quantityText: 'otra unidad',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
    expect(
      groundCartQuantity(
        input({
          text: 'Quiero que agregues otra unidad de croquetas nupec',
          operation: 'set',
          quantity: 1,
          quantityText: 'otra',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });
});

describe('groundCartQuantity named whole-line removal (S4)', () => {
  it('accepts a line clear named by a server-trusted product label', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita el ibuprofeno',
          operation: 'remove',
          productName: 'Ibuprofeno',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'remove', quantity: 0 },
    });
  });

  it('accepts a line clear named by a trusted product plus variant label', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita el ibuprofeno de 500mg',
          operation: 'remove',
          productName: 'Ibuprofeno',
          variantName: '500mg',
        }),
      ),
    ).toEqual({
      kind: 'ready',
      intent: { productId, operation: 'remove', quantity: 0 },
    });
  });

  it('still rejects a partial count even when the named product is trusted (S4)', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita una unidad de ibuprofeno',
          operation: 'remove',
          quantity: null,
          quantityText: null,
          productName: 'Ibuprofeno',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('ignores a model-supplied label that the current text does not contain', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quita el ibuprofeno',
          operation: 'remove',
          productName: 'Paracetamol',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });

  it('fails closed when the current text negates the named removal (S4)', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'No eliminar el ibuprofeno',
          operation: 'remove',
          quantity: 0,
          quantityText: null,
          continuation: false,
          productName: 'Ibuprofeno',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });
});

describe('trusted presentation role grounding', () => {
  it.each([
    [1, '500mg'],
    [1, null],
    [500, '500mg'],
  ])(
    'asks rather than adopting presentation-only proposal %s/%s',
    (quantity, quantityText) => {
      expect(
        groundCartQuantity(
          input({
            text: 'Si, la de 500mg por favor.',
            variantName: '500mg',
            productName: 'Ibuprofeno',
            quantity,
            quantityText,
          }),
        ),
      ).toEqual({
        kind: 'quantity_required',
        intent: { productId, operation: 'add' },
      });
    },
  );
  it.each(['un', 'un ibuprofeno de 500', 'un ibuprofeno de 500mg'])(
    'grounds one from broad or precise citation %s',
    (quantityText) => {
      const text = quantityText.endsWith('mg')
        ? 'Quiero agregar un ibuprofeno de 500mg'
        : 'Quiero agregar un ibuprofeno de 500';
      expect(
        groundCartQuantity(
          input({
            text,
            productName: 'Ibuprofeno',
            variantName: 'Tabletas 500mg',
            quantity: 1,
            quantityText,
          }),
        ),
      ).toEqual({
        kind: 'ready',
        intent: { productId, operation: 'add', quantity: 1 },
      });
    },
  );
  it.each([
    [
      'Agrega 500 unidades de ibuprofeno de 500mg',
      '500 unidades',
      500,
      'ready',
    ],
    [
      'Agrega 2 o 3 ibuprofenos de 500mg',
      '2 o 3 ibuprofenos de 500mg',
      2,
      'invalid_evidence',
    ],
    ['Si, la de 250mg', '250mg', 1, 'invalid_evidence'],
    ['Agrega un ibuprofeno de 500', 'un ibuprofeno de 500', 1, 'ready'],
    ['Agrega un ibuprofeno de 500', null, 1, 'invalid_evidence'],
  ])(
    'preserves count/evidence control %s',
    (text, quantityText, quantity, kind) => {
      expect(
        groundCartQuantity(
          input({
            text,
            quantityText,
            quantity,
            productName: 'Ibuprofeno',
            variantName: '500mg',
          }),
        ).kind,
      ).toBe(kind);
    },
  );
  it('keeps wrong SET on explicit ADD rejected', () => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quiero agregar un ibuprofeno de 500',
          quantity: 1,
          quantityText: 'un ibuprofeno de 500',
          operation: 'set',
          productName: 'Ibuprofeno',
          variantName: '500mg',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  });
});

it.each([undefined, 'Presentación 500', '250mg', '500mg / 250mg'])(
  'keeps unsupported trusted label %s fail-closed for broad citations',
  (variantName) => {
    expect(
      groundCartQuantity(
        input({
          text: 'Quiero agregar un ibuprofeno de 500',
          productName: 'Ibuprofeno',
          variantName,
          quantity: 1,
          quantityText: 'un ibuprofeno de 500',
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  },
);
it('retains real 500-unit count inside a broad presentation citation', () => {
  expect(
    groundCartQuantity(
      input({
        text: 'Agrega 500 unidades de ibuprofeno de 500mg',
        productName: 'Ibuprofeno',
        variantName: '500mg',
        quantity: 500,
        quantityText: '500 unidades de ibuprofeno de 500mg',
      }),
    ),
  ).toEqual({
    kind: 'ready',
    intent: { productId, operation: 'add', quantity: 500 },
  });
});
it('does not let diagnostic exceptions change a rejection', () => {
  expect(
    groundCartQuantity(
      input({
        text: 'Agrega un ibuprofeno de 500',
        operation: 'set',
        productName: 'Ibuprofeno',
        variantName: '500mg',
        quantity: 1,
        quantityText: 'un',
        onRejection: () => {
          throw new Error('logger failed');
        },
      }),
    ),
  ).toEqual({ kind: 'invalid_evidence' });
});

it.each([undefined, { productId, operation: 'add' as const, quantity: 2 }])(
  'rejects mixed-dose confirmation before clarification or pending carry (%s)',
  (pending) => {
    expect(
      groundCartQuantity(
        input({
          text: 'Si, la de 500mg o 250mg por favor.',
          productName: 'Ibuprofeno',
          variantName: '500mg',
          operation: 'add',
          quantity: 1,
          quantityText: '500mg',
          continuation: true,
          pending,
        }),
      ),
    ).toEqual({ kind: 'invalid_evidence' });
  },
);
