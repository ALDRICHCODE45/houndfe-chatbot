import {
  CatalogStockRecoveryRun,
  selectCatalogStockRecovery,
  type CatalogStockRecoverySnapshot,
} from './catalog-stock-recovery';
import type { InventoryCallEvidence } from './inventory-evidence.guard';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const VARIANT_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_VARIANT_ID = '00000000-0000-4000-8000-000000000004';

type Variant =
  CatalogStockRecoverySnapshot['products'][number]['variants'][number];

const product = (
  productId: string,
  name: string,
  variants: Variant[] = [],
): CatalogStockRecoverySnapshot['products'][number] => ({
  productId,
  name,
  variants,
});

const simple = {
  products: [product(PRODUCT_ID, 'Ibuprofeno de 400 mg')],
};
const twoDoses = {
  products: [
    product(PRODUCT_ID, 'Ibuprofeno de 400 mg'),
    product(OTHER_ID, 'Ibuprofeno de 800 mg'),
  ],
};
const variant = (variantId: string, name: string): Variant => ({
  variantId,
  name,
  option: null,
  value: null,
});
const withVariants = {
  products: [
    product(PRODUCT_ID, 'Ibuprofeno de 400 mg', [
      variant(VARIANT_ID, 'Caja con 20 tabletas'),
      variant(OTHER_VARIANT_ID, 'Caja con 40 tabletas'),
    ]),
  ],
};

const select = (
  text: string,
  snapshot: CatalogStockRecoverySnapshot | null = simple,
  history: { role: string; content: unknown }[] = [],
) => selectCatalogStockRecovery({ text, history, snapshot });

const availabilityQuestion = {
  role: 'assistant',
  content:
    'Claro. ¿Quieres que revise la disponibilidad de Ibuprofeno de 400 mg?',
};

describe('selectCatalogStockRecovery', () => {
  it('recovers the single product named by a bounded availability phrase', () => {
    expect(select('Buenas tardes, tienen ibuprofeno?')).toEqual({
      kind: 'recover',
      target: { productId: PRODUCT_ID, variantId: null },
    });
  });

  it('uses the dose in the phrase to disambiguate two snapshot products', () => {
    expect(select('tienen ibuprofeno de 800 mg?', twoDoses)).toEqual({
      kind: 'recover',
      target: { productId: OTHER_ID, variantId: null },
    });
  });

  it('refuses an ambiguous reference that matches several products', () => {
    expect(select('tienen ibuprofeno?', twoDoses)).toEqual({ kind: 'none' });
  });

  it('requires an explicit variant when the product has variants', () => {
    expect(select('tienen ibuprofeno?', withVariants)).toEqual({
      kind: 'none',
    });
    expect(
      select('tienen ibuprofeno caja con 20 tabletas?', withVariants),
    ).toEqual({
      kind: 'recover',
      target: { productId: PRODUCT_ID, variantId: VARIANT_ID },
    });
  });

  it('rejects a dose that no snapshot product matches', () => {
    expect(select('tienen ibuprofeno de 600 mg?')).toEqual({ kind: 'none' });
  });

  it('rejects a missing or empty snapshot', () => {
    expect(select('tienen ibuprofeno?', null)).toEqual({ kind: 'none' });
    expect(select('tienen ibuprofeno?', { products: [] })).toEqual({
      kind: 'none',
    });
  });

  it('ignores transactional text without availability intent', () => {
    expect(select('Quiero comprar ibuprofeno de 400 mg')).toEqual({
      kind: 'none',
    });
    expect(select('el ibuprofeno de 400 mg')).toEqual({ kind: 'none' });
  });

  it('recovers a strict affirmative continuation of an availability question', () => {
    expect(
      select('Si por favor', simple, [
        { role: 'user', content: 'Buenas tardes, tienen ibuprofeno?' },
        availabilityQuestion,
      ]),
    ).toEqual({
      kind: 'recover',
      target: { productId: PRODUCT_ID, variantId: null },
    });
  });

  it('requires an availability question immediately before the affirmative', () => {
    expect(
      select('Si por favor', simple, [
        { role: 'assistant', content: 'Su pedido ya está listo para envío.' },
      ]),
    ).toEqual({ kind: 'none' });
    expect(
      select('Si por favor', simple, [
        availabilityQuestion,
        { role: 'user', content: 'algo más' },
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('rejects a negative or changed-subject continuation', () => {
    expect(select('No gracias', simple, [availabilityQuestion])).toEqual({
      kind: 'none',
    });
    expect(
      select('Si por favor', simple, [
        {
          role: 'assistant',
          content:
            '¿Quieres que revise la disponibilidad de Paracetamol 500 mg?',
        },
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('requires a real customer availability intent, not assistant prose alone', () => {
    // The assistant offered to check stock, but the customer never asked for it.
    expect(
      select('Si por favor', simple, [
        { role: 'user', content: 'Hola' },
        availabilityQuestion,
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('rejects an unrelated customer product even when the assistant proposes stock', () => {
    expect(
      select('Si por favor', simple, [
        { role: 'user', content: '¿Tienen paracetamol?' },
        availabilityQuestion,
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('rejects a subject shift between the customer and the assistant', () => {
    const both = {
      products: [
        product(PRODUCT_ID, 'Ibuprofeno de 400 mg'),
        product(OTHER_ID, 'Paracetamol 500 mg'),
      ],
    };
    expect(
      select('Si por favor', both, [
        { role: 'user', content: '¿Tienen ibuprofeno?' },
        {
          role: 'assistant',
          content:
            '¿Quieres que revise la disponibilidad de Paracetamol 500 mg?',
        },
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('rejects a proposed subject the snapshot does not support', () => {
    // The assistant offered to check a product the snapshot cannot resolve;
    // an unsupported proposal must never be ignored in favor of the customer.
    expect(
      select('Si por favor', simple, [
        { role: 'user', content: '¿Tienen ibuprofeno?' },
        {
          role: 'assistant',
          content: '¿Quieres que revise disponibilidad de paracetamol?',
        },
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('rejects a proposed variant that conflicts with the customer variant', () => {
    expect(
      select('Si por favor', withVariants, [
        {
          role: 'user',
          content: '¿Tienen Ibuprofeno de 400 mg caja con 20 tabletas?',
        },
        {
          role: 'assistant',
          content:
            '¿Quieres que revise la disponibilidad de Ibuprofeno de 400 mg caja con 40 tabletas?',
        },
      ]),
    ).toEqual({ kind: 'none' });
  });

  it('recovers when the assistant asks a generic question without a subject', () => {
    // A question with no product of its own constrains nothing: the real
    // customer quote still names the product and must be recovered.
    expect(
      select('Si por favor', simple, [
        { role: 'user', content: '¿Tienen disponible Ibuprofeno de 400 mg?' },
        {
          role: 'assistant',
          content: '¿Le gustaría que revisara su disponibilidad?',
        },
      ]),
    ).toEqual({
      kind: 'recover',
      target: { productId: PRODUCT_ID, variantId: null },
    });
  });

  it('rejects an affirmative when the customer intent is not immediately prior', () => {
    expect(
      select('Si por favor', simple, [
        { role: 'user', content: '¿Tienen ibuprofeno?' },
        { role: 'assistant', content: 'Sí, claro.' },
        availabilityQuestion,
      ]),
    ).toEqual({ kind: 'none' });
  });
});

describe('CatalogStockRecoveryRun', () => {
  const evidence = (
    over: Partial<InventoryCallEvidence> = {},
  ): InventoryCallEvidence => ({
    toolCallId: 'call',
    toolName: 'checkStock',
    input: { productId: PRODUCT_ID },
    state: 'result',
    output: { ok: true, productId: PRODUCT_ID },
    ...over,
  });
  const identityFailure = (toolCallId = 'fail'): InventoryCallEvidence =>
    evidence({
      toolCallId,
      output: { ok: false, error: { kind: 'catalog_identity_unverified' } },
    });
  const searchSuccess = (toolCallId = 'search'): InventoryCallEvidence =>
    evidence({
      toolCallId,
      toolName: 'searchCatalog',
      input: { q: 'ibuprofeno', limit: 20 },
      output: { ok: true, requires_check_stock: true, results: [] },
    });
  const recover = () =>
    new CatalogStockRecoveryRun({
      checkStockAvailable: true,
      select: () => ({
        kind: 'recover',
        target: { productId: PRODUCT_ID, variantId: null },
      }),
    });
  const arm = (run: CatalogStockRecoveryRun): CatalogStockRecoveryRun => {
    expect(run.completeStep([identityFailure()]).fault).toBe(false);
    expect(run.completeStep([searchSuccess()]).fault).toBe(false);
    return run;
  };

  it('does not arm before an observed identity failure and a later fresh search', () => {
    const run = recover();
    expect(run.nextDirective()).toEqual({ kind: 'none' });
    run.completeStep([identityFailure()]);
    expect(run.nextDirective()).toEqual({ kind: 'none' });
    run.completeStep([identityFailure('fail2')]);
    expect(run.nextDirective()).toEqual({ kind: 'none' });
  });

  it('does not arm from a search alone or from a failure and search in one step', () => {
    const searchOnly = recover();
    searchOnly.completeStep([searchSuccess()]);
    expect(searchOnly.nextDirective()).toEqual({ kind: 'none' });

    const sameStep = recover();
    sameStep.completeStep([identityFailure(), searchSuccess()]);
    expect(sameStep.nextDirective()).toEqual({ kind: 'none' });
  });

  it('does not arm when the search precedes the identity failure', () => {
    const run = recover();
    run.completeStep([searchSuccess()]);
    run.completeStep([identityFailure()]);
    expect(run.nextDirective()).toEqual({ kind: 'none' });
  });

  it('forces the trusted stock input, then a tool-free final step', () => {
    const run = arm(recover());
    expect(run.extendsBudget).toBe(false);
    expect(run.nextDirective()).toEqual({
      kind: 'force-stock',
      target: { productId: PRODUCT_ID, variantId: null },
    });
    expect(run.extendsBudget).toBe(true);
    const outcome = run.completeStep([
      evidence({ toolCallId: 'forced', input: { productId: OTHER_ID } }),
    ]);
    expect(outcome.fault).toBe(false);
    expect(outcome.calls[0].input).toEqual({ productId: PRODUCT_ID });
    expect(run.nextDirective()).toEqual({ kind: 'force-final' });
    expect(run.completeStep([]).fault).toBe(false);
    expect(run.phase).toBe('complete');
    expect(run.extendsBudget).toBe(false);
    expect(run.nextDirective()).toEqual({ kind: 'none' });
  });

  it('preserves a named variant in the forced input', () => {
    const run = new CatalogStockRecoveryRun({
      checkStockAvailable: true,
      select: () => ({
        kind: 'recover',
        target: { productId: PRODUCT_ID, variantId: VARIANT_ID },
      }),
    });
    arm(run);
    run.nextDirective();
    const outcome = run.completeStep([evidence({ toolCallId: 'forced' })]);
    expect(outcome.calls[0].input).toEqual({
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
    });
  });

  it('fails closed when the provider ignores the forced stock step', () => {
    const run = arm(recover());
    run.nextDirective();
    const outcome = run.completeStep([
      evidence({ toolCallId: 'text', toolName: 'searchCatalog' }),
    ]);
    expect(outcome.fault).toBe(true);
    expect(run.failed).toBe(true);
    expect(run.nextDirective()).toEqual({ kind: 'fail-closed' });
  });

  it('fails closed on a duplicate forced stock call', () => {
    const run = arm(recover());
    run.nextDirective();
    const outcome = run.completeStep([
      evidence({ toolCallId: 'a' }),
      evidence({ toolCallId: 'b' }),
    ]);
    expect(outcome.fault).toBe(true);
    expect(run.failed).toBe(true);
  });

  it('fails closed when the forced final step still calls tools', () => {
    const run = arm(recover());
    run.nextDirective();
    run.completeStep([evidence({ toolCallId: 'forced' })]);
    const outcome = run.completeStep([evidence({ toolCallId: 'late' })]);
    expect(outcome.fault).toBe(true);
    expect(run.failed).toBe(true);
  });

  it('declines and owes a clarification when the selector finds no single product', () => {
    const declined = new CatalogStockRecoveryRun({
      checkStockAvailable: true,
      select: () => ({ kind: 'none' }),
    });
    arm(declined);
    expect(declined.nextDirective()).toEqual({ kind: 'none' });
    expect(declined.requiresClarification).toBe(true);
  });

  it('does not clarify without a fresh snapshot or an evaluated gate', () => {
    const noSnapshot = new CatalogStockRecoveryRun({
      checkStockAvailable: true,
      select: () => ({ kind: 'none' }),
      snapshotAvailable: () => false,
    });
    arm(noSnapshot);
    noSnapshot.nextDirective();
    expect(noSnapshot.requiresClarification).toBe(false);

    const notEvaluated = new CatalogStockRecoveryRun({
      checkStockAvailable: true,
      select: () => ({ kind: 'none' }),
    });
    arm(notEvaluated);
    expect(notEvaluated.requiresClarification).toBe(false);
  });

  it('does not arm when checkStock is unavailable', () => {
    const unavailable = new CatalogStockRecoveryRun({
      checkStockAvailable: false,
      select: () => ({
        kind: 'recover',
        target: { productId: PRODUCT_ID, variantId: null },
      }),
    });
    expect(unavailable.nextDirective()).toEqual({ kind: 'none' });
    expect(unavailable.requiresClarification).toBe(false);
  });

  it('keeps the ordinary workflow free before the recovery arms', () => {
    const run = recover();
    expect(run.deniesExecution('createSale')).toBe(false);
    expect(run.deniesExecution('checkStock')).toBe(false);
    arm(run);
    expect(run.deniesExecution('createSale')).toBe(false);
  });

  it('locks execution to the single authorized stock call after arming', () => {
    const run = arm(recover());
    run.nextDirective();
    // Only the first checkStock is authorized; the final step allows nothing.
    expect(run.deniesExecution('checkStock')).toBe(false);
    expect(run.deniesExecution('checkStock')).toBe(true);
    expect(run.deniesExecution('createSale')).toBe(true);
    expect(run.deniesExecution('searchCatalog')).toBe(true);
    run.completeStep([evidence({ toolCallId: 'forced' })]);
    expect(run.deniesExecution('createSale')).toBe(true);
    expect(run.deniesExecution('checkStock')).toBe(true);
    expect(run.deniesExecution('searchCatalog')).toBe(true);
  });
});
