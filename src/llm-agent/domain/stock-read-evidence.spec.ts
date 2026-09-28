import {
  StockReadEvidence,
  UNBOUND_STOCK_REPLY,
  type AdmittedToolCall,
  type StockReadReceiptInput,
  type StockReadSubject,
  type StockUnverifiedReason,
  type TrustedStockSubject,
} from './stock-read-evidence';

const TURN = 'turn-1';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-0000000000aa';
const VARIANT_20 = '00000000-0000-4000-8000-0000000000f1';
const VARIANT_40 = '00000000-0000-4000-8000-0000000000f2';
const PRODUCT_NAME = 'Ibuprofeno de 400 mg';

const subject = (
  over: Partial<TrustedStockSubject> = {},
): TrustedStockSubject => ({
  productId: PRODUCT_ID,
  variantId: null,
  productName: PRODUCT_NAME,
  variantName: null,
  ...over,
});

const productOnly: StockReadSubject = {
  productId: PRODUCT_ID,
  variantId: null,
};
const variantSubject = (variantId: string): StockReadSubject => ({
  productId: PRODUCT_ID,
  variantId,
});

const stockOutput = (
  status: string,
  quantity: number | null,
  over: {
    productId?: string;
    name?: string;
    variants?: unknown[];
  } = {},
) => ({
  ok: true as const,
  productId: over.productId ?? PRODUCT_ID,
  name: over.name ?? PRODUCT_NAME,
  stock: { status, quantity },
  variants: over.variants ?? [],
});

const variantNode = (
  variantId: string,
  name: string,
  status: string,
  quantity: number | null,
) => ({
  variantId,
  name,
  option: null,
  value: null,
  stock: { status, quantity },
});

const receipt = (
  toolCallId: string,
  step: number,
  over: Partial<StockReadReceiptInput> = {},
): StockReadReceiptInput => ({
  serverTurnId: TURN,
  toolCallId,
  step,
  subject: null,
  catalogGenerationBefore: 1,
  catalogGenerationAfter: 1,
  output: stockOutput('available', 5),
  ...over,
});

const call = (
  toolCallId: string,
  productId: string,
  variantId?: string,
): AdmittedToolCall => ({
  toolCallId,
  toolName: 'checkStock',
  input: { productId, ...(variantId ? { variantId } : {}) },
  outcome: 'result',
});

describe('StockReadEvidence', () => {
  describe('per-subject reduction', () => {
    it('renders only the verified subject when an unbound failure precedes it', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(receipt('a', 0));
      store.recordExecution(
        receipt('b', 1, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [call('a', OTHER_ID)]);
      store.admitCompletedStep(1, [call('b', PRODUCT_ID)]);

      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'verified',
        status: 'out_of_stock',
        quantity: 0,
        step: 1,
      });
      expect(store.projectStockFacts()).toBe(
        'Por el momento no tenemos existencias de Ibuprofeno de 400 mg.',
      );
    });

    it('lets a later failure for the same subject supersede its earlier success', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('s', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.recordExecution(
        receipt('f', 1, {
          subject: subject(),
          catalogGenerationAfter: 2,
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [call('s', PRODUCT_ID)]);
      store.admitCompletedStep(1, [call('f', PRODUCT_ID)]);

      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
        reason: 'catalog_changed',
      });
      expect(store.projectStockFacts()).toBe(
        'No pude confirmar las existencias de Ibuprofeno de 400 mg en esta consulta.',
      );
      expect(store.getLatestVerifiedShortage(productOnly, 2)).toBeNull();
    });

    it('clears a same-subject failure once a later read is verified', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('f', 0, {
          subject: subject(),
          output: { ok: false, error: { kind: 'backend_unavailable' } },
        }),
      );
      store.recordExecution(
        receipt('s', 1, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [call('f', PRODUCT_ID)]);
      store.admitCompletedStep(1, [call('s', PRODUCT_ID)]);

      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'verified',
        status: 'out_of_stock',
      });
      expect(store.getLatestVerifiedShortage(productOnly, 2)).not.toBeNull();
    });

    it('keeps product-only and variant subjects isolated', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('p', 0, {
          subject: subject(),
          output: stockOutput('available', 7),
        }),
      );
      store.recordExecution(
        receipt('v', 1, {
          subject: subject({
            variantId: VARIANT_40,
            variantName: 'caja con 40',
          }),
          output: stockOutput('available', 7, {
            variants: [variantNode(VARIANT_20, 'caja con 20', 'available', 3)],
          }),
        }),
      );
      store.admitCompletedStep(0, [call('p', PRODUCT_ID)]);
      store.admitCompletedStep(1, [call('v', PRODUCT_ID, VARIANT_40)]);

      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'verified',
        status: 'available',
      });
      expect(
        store.getLatestCompleted(variantSubject(VARIANT_40)),
      ).toMatchObject({ kind: 'unconfirmed', reason: 'mismatch' });
      expect(store.getLatestCompleted(variantSubject(VARIANT_20))).toBeNull();
    });

    it('reads product-only stock from the product node, never a variant', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('p', 0, {
          subject: subject(),
          output: stockOutput('available', 7, {
            variants: [
              variantNode(VARIANT_20, 'caja con 20', 'out_of_stock', 0),
            ],
          }),
        }),
      );
      store.admitCompletedStep(0, [call('p', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'verified',
        status: 'available',
        quantity: 7,
      });
    });

    it('treats malformed or non-authoritative quantities as unverified', () => {
      const cases: Array<[unknown, StockUnverifiedReason]> = [
        [stockOutput('available', null), 'inconsistent'],
        [stockOutput('out_of_stock', 5), 'inconsistent'],
        [stockOutput('available', -1), 'inconsistent'],
        [stockOutput('low_stock', 1.5), 'inconsistent'],
        [stockOutput('not_managed', null), 'not_managed'],
      ];
      for (const [output, reason] of cases) {
        const store = new StockReadEvidence(TURN);
        store.recordExecution(receipt('r', 0, { subject: subject(), output }));
        store.admitCompletedStep(0, [call('r', PRODUCT_ID)]);
        expect(store.getLatestCompleted(productOnly)).toMatchObject({
          kind: 'unconfirmed',
          reason,
        });
      }
    });
  });

  describe('provenance and admission', () => {
    it('does not trust a model-shaped success without a server subject', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('a', 0, { subject: null, output: stockOutput('available', 9) }),
      );
      store.admitCompletedStep(0, [call('a', PRODUCT_ID)]);

      expect(store.getLatestCompleted(productOnly)).toBeNull();
      expect(store.projectStockFacts()).toBe(UNBOUND_STOCK_REPLY);
    });

    it('fails closed on a missing receipt', () => {
      const store = new StockReadEvidence(TURN);
      store.admitCompletedStep(0, [call('x', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toBeNull();
      expect(store.projectStockFacts()).toBe(UNBOUND_STOCK_REPLY);
    });

    it('fails closed when the model input disagrees with the recorded subject', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('r', 0, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [call('r', OTHER_ID)]);
      expect(store.getLatestCompleted(productOnly)).toBeNull();
    });

    it('fails closed on duplicate call ids', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('r', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.recordExecution(
        receipt('r', 0, {
          subject: subject(),
          output: stockOutput('available', 6),
        }),
      );
      store.admitCompletedStep(0, [call('r', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toBeNull();
    });

    it('binds receipts to the constructor server turn', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('r', 0, {
          serverTurnId: 'another-turn',
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [call('r', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toBeNull();
    });

    it('fails closed when the catalog generation changed in flight', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('r', 0, {
          subject: subject(),
          catalogGenerationBefore: 1,
          catalogGenerationAfter: 2,
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [call('r', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
        reason: 'catalog_changed',
      });
    });

    it('fails closed on a backend error envelope', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('r', 0, {
          subject: subject(),
          output: {
            ok: false,
            error: { kind: 'backend_unavailable', retryable: true },
          },
        }),
      );
      store.admitCompletedStep(0, [call('r', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
        reason: 'backend_error',
      });
    });

    it('ignores out-of-order admissions instead of restoring an older fact', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('old', 0, {
          subject: subject(),
          output: { ok: false, error: { kind: 'backend_unavailable' } },
        }),
      );
      store.recordExecution(
        receipt('new', 1, {
          subject: subject(),
          output: stockOutput('available', 4),
        }),
      );
      store.admitCompletedStep(1, [call('new', PRODUCT_ID)]);
      store.admitCompletedStep(0, [call('old', PRODUCT_ID)]);
      store.admitCompletedStep(1, [call('new', PRODUCT_ID)]);

      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'verified',
        status: 'available',
        quantity: 4,
      });
    });

    it('lets a same-step failure dominate a same-step success for one subject', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('ok', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.recordExecution(
        receipt('bad', 0, {
          subject: subject(),
          catalogGenerationAfter: 2,
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [
        call('ok', PRODUCT_ID),
        call('bad', PRODUCT_ID),
      ]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
        reason: 'catalog_changed',
      });
    });
  });

  describe('admission regressions', () => {
    const seeded = () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('initial', 0, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [call('initial', PRODUCT_ID)]);
      return store;
    };

    it.each(['missing', 'unbound', 'error', 'unknown'])(
      'revokes a previous shortage on a later %s completion',
      (mode) => {
        const store = seeded();
        const next = call('later', PRODUCT_ID);
        if (mode !== 'missing') {
          store.recordExecution(
            receipt('later', 1, {
              subject: mode === 'unbound' ? null : subject(),
              output: stockOutput('out_of_stock', 0),
            }),
          );
        }
        if (mode === 'error') next.outcome = 'error';
        if (mode === 'unknown') Reflect.deleteProperty(next, 'outcome');
        store.admitCompletedStep(1, [next]);
        expect(store.getLatestVerifiedShortage(productOnly, 2)).toBeNull();
        expect(store.projectStockFacts()).toBe(
          `No pude confirmar las existencias de ${PRODUCT_NAME} en esta consulta.`,
        );
      },
    );

    it.each(['denied', 'unaccounted'])(
      'revokes a prior shortage when a later completion is %s',
      (mode) => {
        const store = seeded();
        const next = call('later', PRODUCT_ID);
        next.outcome = mode as AdmittedToolCall['outcome'];
        // A receipt may exist (a denied call never executes, so it usually
        // will not), but the terminal outcome alone must revoke the fact.
        store.recordExecution(receipt('later', 1, { subject: subject() }));
        store.admitCompletedStep(1, [next]);
        expect(store.getLatestVerifiedShortage(productOnly, 2)).toBeNull();
        expect(store.getLatestCompleted(productOnly)).toMatchObject({
          kind: 'unconfirmed',
          reason: 'identity_unverified',
        });
        expect(store.hasVerifiedShortage()).toBe(false);
      },
    );

    it('reports hasVerifiedShortage only for a live quantity-zero shortage', () => {
      const store = new StockReadEvidence(TURN);
      expect(store.hasVerifiedShortage()).toBe(false);
      store.recordExecution(
        receipt('available', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [call('available', PRODUCT_ID)]);
      expect(store.hasVerifiedShortage()).toBe(false);
      store.recordExecution(
        receipt('short', 1, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(1, [call('short', PRODUCT_ID)]);
      expect(store.hasVerifiedShortage()).toBe(true);
    });

    it.each([false, true])(
      'lets a missing receipt dominate same-step success (reverse=%s)',
      (reverse) => {
        const store = new StockReadEvidence(TURN);
        store.recordExecution(receipt('good', 0, { subject: subject() }));
        const calls = [call('good', PRODUCT_ID), call('missing', PRODUCT_ID)];
        store.admitCompletedStep(0, reverse ? calls.reverse() : calls);
        expect(store.getLatestCompleted(productOnly)?.kind).toBe('unconfirmed');
      },
    );

    it.each([PRODUCT_ID, OTHER_ID])(
      'rejects duplicate SDK call ids with second input %s',
      (secondId) => {
        const store = seeded();
        store.recordExecution(receipt('duplicate', 1, { subject: subject() }));
        store.recordExecution(
          receipt('independent', 1, {
            subject: subject({ productId: OTHER_ID }),
            output: stockOutput('available', 3, { productId: OTHER_ID }),
          }),
        );
        store.admitCompletedStep(1, [
          call('duplicate', PRODUCT_ID),
          call('duplicate', secondId),
          call('independent', OTHER_ID),
        ]);
        expect(store.getLatestVerifiedShortage(productOnly, 2)).toBeNull();
        expect(store.getLatestCompleted(productOnly)?.kind).toBe('unconfirmed');
        // Only a subject implicated in ambiguity loses authority.
        expect(
          store.getLatestCompleted({ productId: OTHER_ID, variantId: null })
            ?.kind,
        ).toBe(secondId === OTHER_ID ? 'unconfirmed' : 'verified');
      },
    );

    it('revokes the recorded subject when SDK input names another subject', () => {
      const store = seeded();
      store.recordExecution(receipt('mismatch', 1, { subject: subject() }));
      store.admitCompletedStep(1, [call('mismatch', OTHER_ID)]);
      expect(store.getLatestVerifiedShortage(productOnly, 2)).toBeNull();
      expect(store.getLatestCompleted(productOnly)?.kind).toBe('unconfirmed');
      expect(
        store.getLatestCompleted({ productId: OTHER_ID, variantId: null }),
      ).toBeNull();
    });

    it('rejects reuse of a previously admitted call id in a later step', () => {
      const store = new StockReadEvidence(TURN);
      store.admitCompletedStep(0, [call('reused', PRODUCT_ID)]);
      store.recordExecution(receipt('reused', 1, { subject: subject() }));
      store.admitCompletedStep(1, [call('reused', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toBeNull();
      expect(store.projectStockFacts()).toBe(UNBOUND_STOCK_REPLY);
    });

    it('does not let an unrelated failure revoke a valid shortage', () => {
      const store = seeded();
      store.admitCompletedStep(1, [call('missing', OTHER_ID)]);
      expect(store.getLatestVerifiedShortage(productOnly, 2)).not.toBeNull();
    });

    it('captures detached values before caller-owned data can change', () => {
      const store = new StockReadEvidence(TURN);
      const trusted = subject();
      const output = stockOutput('out_of_stock', 0);
      const execution = receipt('snapshot', 0, { subject: trusted, output });
      store.recordExecution(execution);
      trusted.productName = 'Injected label';
      output.stock.status = 'available';
      output.stock.quantity = 10;
      execution.catalogGenerationAfter = 50;
      store.admitCompletedStep(0, [call('snapshot', PRODUCT_ID)]);
      expect(store.getLatestVerifiedShortage(productOnly, 1)).toMatchObject({
        productName: PRODUCT_NAME,
        status: 'out_of_stock',
      });
      expect(store.projectStockFacts()).not.toContain('Injected');
    });

    it.each(['latest', 'shortage'])(
      'does not expose internal authority through the %s accessor',
      (accessor) => {
        const store = seeded();
        const exposed =
          accessor === 'latest'
            ? store.getLatestCompleted(productOnly)
            : store.getLatestVerifiedShortage(productOnly, 1);
        expect(exposed?.kind).toBe('verified');
        // Detached or frozen views are both valid; Reflect avoids throw-based assertions.
        Reflect.set(exposed!, 'productName', 'Injected label');
        Reflect.set(exposed!, 'status', 'available');
        Reflect.set(exposed!.subject!, 'productId', OTHER_ID);
        expect(store.getLatestVerifiedShortage(productOnly, 1)).toMatchObject({
          productName: PRODUCT_NAME,
          subject: productOnly,
          status: 'out_of_stock',
        });
      },
    );

    it.each([undefined, NaN, -1, 0.5, Infinity])(
      'rejects matching but invalid generations %s',
      (generation) => {
        const store = new StockReadEvidence(TURN);
        const execution = receipt('generation', 0, { subject: subject() });
        Object.assign(execution, {
          catalogGenerationBefore: generation,
          catalogGenerationAfter: generation,
        });
        store.recordExecution(execution);
        store.admitCompletedStep(0, [call('generation', PRODUCT_ID)]);
        expect(store.getLatestCompleted(productOnly)).toMatchObject({
          kind: 'unconfirmed',
          reason: 'catalog_changed',
        });
      },
    );
  });

  describe('getLatestVerifiedShortage', () => {
    const storeWithShortageAt = (step: number): StockReadEvidence => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('s', step, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(step, [call('s', PRODUCT_ID)]);
      return store;
    };

    it('returns a prior-step shortage for the exact subject only', () => {
      const store = storeWithShortageAt(1);
      expect(store.getLatestVerifiedShortage(productOnly, 1)).toBeNull();
      expect(store.getLatestVerifiedShortage(productOnly, 2)).toMatchObject({
        kind: 'verified',
        status: 'out_of_stock',
        quantity: 0,
      });
      expect(
        store.getLatestVerifiedShortage(
          { productId: OTHER_ID, variantId: null },
          2,
        ),
      ).toBeNull();
    });

    it('does not revive a shortage once a later read for the subject failed', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('s', 0, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.recordExecution(
        receipt('f', 1, {
          subject: subject(),
          output: { ok: false, error: { kind: 'backend_unavailable' } },
        }),
      );
      store.admitCompletedStep(0, [call('s', PRODUCT_ID)]);
      store.admitCompletedStep(1, [call('f', PRODUCT_ID)]);
      expect(store.getLatestVerifiedShortage(productOnly, 2)).toBeNull();
    });

    it('never returns an available status as a shortage', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('s', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [call('s', PRODUCT_ID)]);
      expect(store.getLatestVerifiedShortage(productOnly, 1)).toBeNull();
    });
  });

  describe('projectStockFacts', () => {
    it('returns null when no stock read was attempted', () => {
      expect(new StockReadEvidence(TURN).projectStockFacts()).toBeNull();
    });

    it('projects warm verified availability from trusted names', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('s', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [call('s', PRODUCT_ID)]);
      expect(store.projectStockFacts()).toBe(
        'Con gusto le confirmo que Ibuprofeno de 400 mg sí está disponible.',
      );
    });

    it('names the presentation for a verified variant', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('v', 0, {
          subject: subject({
            variantId: VARIANT_20,
            variantName: 'caja con 20 tabletas',
          }),
          output: stockOutput('available', 4, {
            variants: [
              variantNode(VARIANT_20, 'caja con 20 tabletas', 'available', 4),
            ],
          }),
        }),
      );
      store.admitCompletedStep(0, [call('v', PRODUCT_ID, VARIANT_20)]);
      expect(store.projectStockFacts()).toBe(
        'Con gusto le confirmo que Ibuprofeno de 400 mg (caja con 20 tabletas) sí está disponible.',
      );
    });

    it('reports a trusted failure as unconfirmed with its trusted name', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('f', 0, {
          subject: subject(),
          output: { ok: false, error: { kind: 'backend_unavailable' } },
        }),
      );
      store.admitCompletedStep(0, [call('f', PRODUCT_ID)]);
      expect(store.projectStockFacts()).toBe(
        'No pude confirmar las existencias de Ibuprofeno de 400 mg en esta consulta.',
      );
    });
  });

  describe('hasOnlyUnboundFailures', () => {
    it('is true only when every attempt lacked a trusted subject', () => {
      const store = new StockReadEvidence(TURN);
      expect(store.hasOnlyUnboundFailures()).toBe(false);
      store.admitCompletedStep(0, [call('unbound', OTHER_ID)]);
      expect(store.hasOnlyUnboundFailures()).toBe(true);
      expect(store.getLatestCompleted(productOnly)).toBeNull();
      store.recordExecution(
        receipt('trusted', 1, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(1, [call('trusted', PRODUCT_ID)]);
      expect(store.hasOnlyUnboundFailures()).toBe(false);
      expect(store.projectStockFacts()).not.toBe(UNBOUND_STOCK_REPLY);
    });

    it('never grants identity or a write from a failure-only ledger', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(receipt('missing', 0));
      store.admitCompletedStep(0, [call('missing', PRODUCT_ID)]);
      expect(store.hasOnlyUnboundFailures()).toBe(true);
      expect(store.hasVerifiedShortage()).toBe(false);
      expect(store.getLatestCompleted(productOnly)).toBeNull();
    });
  });

  /**
   * S3c2 correction: the ledger must cross-check the SDK completion terminal
   * the adapter hands it against the private receipt. The private receipt
   * stays the sole authority, so a null, failed, or semantically different
   * terminal can never create or corroborate a verified fact. An omitted
   * `output` property keeps the historical receipt-only protocol.
   */
  describe('SDK terminal cross-check (S3c2 correction)', () => {
    const withOutput = (
      toolCallId: string,
      productId: string,
      output: unknown,
      variantId?: string,
    ): AdmittedToolCall => ({
      ...call(toolCallId, productId, variantId),
      output,
    });

    it('keeps the legacy receipt-only protocol when the terminal is omitted', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('a', 0, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [call('a', PRODUCT_ID)]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'verified',
        status: 'out_of_stock',
        quantity: 0,
      });
    });

    it('verifies when the supplied SDK terminal agrees with the private fact', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('a', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [
        withOutput('a', PRODUCT_ID, stockOutput('available', 5)),
      ]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'verified',
        status: 'available',
        quantity: 5,
      });
    });

    it.each([
      ['a null terminal', null],
      ['a failed terminal', { ok: false, error: { kind: 'upstream' } }],
      ['a different quantity', stockOutput('available', 9)],
      ['a different status', stockOutput('low_stock', 3)],
    ])('does not verify when the SDK terminal is %s', (_, terminal) => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('a', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [withOutput('a', PRODUCT_ID, terminal)]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
        reason: 'mismatch',
      });
      expect(store.getLatestVerifiedShortage(productOnly, 1)).toBeNull();
    });

    it('treats a present but undefined terminal as unusable, never a bypass', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('a', 0, {
          subject: subject(),
          output: stockOutput('available', 5),
        }),
      );
      store.admitCompletedStep(0, [withOutput('a', PRODUCT_ID, undefined)]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
      });
    });

    it('never verifies a privately failed read even when the terminal claims stock', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('a', 0, {
          subject: subject(),
          output: { ok: false, error: { kind: 'upstream' } },
        }),
      );
      store.admitCompletedStep(0, [
        withOutput('a', PRODUCT_ID, stockOutput('out_of_stock', 0)),
      ]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
        reason: 'backend_error',
      });
      expect(store.getLatestVerifiedShortage(productOnly, 1)).toBeNull();
    });

    it('revokes a prior verified fact when a later terminal disagrees', () => {
      const store = new StockReadEvidence(TURN);
      store.recordExecution(
        receipt('s', 0, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.recordExecution(
        receipt('t', 1, {
          subject: subject(),
          output: stockOutput('out_of_stock', 0),
        }),
      );
      store.admitCompletedStep(0, [
        withOutput('s', PRODUCT_ID, stockOutput('out_of_stock', 0)),
      ]);
      expect(store.getLatestVerifiedShortage(productOnly, 1)).not.toBeNull();
      // The genuine receipt is still OOS, but the second terminal claims a
      // different status: the subject must be revoked, not upgraded.
      store.admitCompletedStep(1, [
        withOutput('t', PRODUCT_ID, stockOutput('available', 5)),
      ]);
      expect(store.getLatestCompleted(productOnly)).toMatchObject({
        kind: 'unconfirmed',
        reason: 'mismatch',
      });
      expect(store.getLatestVerifiedShortage(productOnly, 2)).toBeNull();
    });
  });
});
