import type { BackorderBot } from '../../backorders/domain/backorder';

/**
 * Shared test data of the restock backorder confirm / checkout specs (T5b).
 * Not a spec: only imported by them.
 */
export const BO_SENDER = '5215550001111';
export const BO_PRODUCT = '11111111-1111-4111-8111-111111111111';
export const BO_CROQUETAS = '77777777-7777-4777-8777-777777777777';
export const BO_ID = '8c1d0000-1111-4222-8333-444455556666';
export const BO_ID_2 = '9d2e0000-1111-4222-8333-444455556666';
export const BO_DECISION = 'a4b50000-1111-4222-8333-444455556666';
export const BO_UNTIL = '2026-11-21T15:00:00.000Z';
/** «Now» of the specs: inside the reservation window. */
export const BO_NOW = Date.parse('2026-11-20T15:00:00.000Z');
export const BO_FINAL_CENTS = 109900;

export const reservedBackorder = (
  overrides: Partial<BackorderBot> & { sourceDecisionId?: string | null } = {},
): BackorderBot => ({
  id: BO_ID,
  folio: 'BO-000012',
  status: 'RESERVED',
  productId: BO_CROQUETAS,
  productName: 'Croquetas Adulto 18 kg',
  variantId: null,
  variantName: null,
  quantity: 2,
  referencePriceCents: 114900,
  currentPriceCents: BO_FINAL_CENTS,
  finalPriceCents: BO_FINAL_CENTS,
  scheduledAt: '2026-11-13T12:00:00.000Z',
  estimatedAt: '2026-11-20T12:00:00.000Z',
  estimatedArrivalDays: 7,
  reservedAt: '2026-11-20T15:00:00.000Z',
  reservedUntil: BO_UNTIL,
  reminderAt: '2026-11-21T12:00:00.000Z',
  queuePosition: null,
  saleId: null,
  cancelledByKind: null,
  cancelReason: null,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
  ...overrides,
});

/** The stored cart line of a reserved backorder (as `addBackorderLine` writes it). */
export const backorderCartLine = (
  overrides: Partial<{
    productId: string;
    variantId: string;
    quantity: number;
    unitPriceCents: number;
    id: string;
    folio: string;
    productName: string;
  }> = {},
) => ({
  productId: overrides.productId ?? BO_CROQUETAS,
  ...(overrides.variantId === undefined
    ? {}
    : { variantId: overrides.variantId }),
  quantity: overrides.quantity ?? 2,
  unitPriceCents: overrides.unitPriceCents ?? BO_FINAL_CENTS,
  backorder: {
    id: overrides.id ?? BO_ID,
    folio: overrides.folio ?? 'BO-000012',
    productName: overrides.productName ?? 'Croquetas Adulto 18 kg',
    variantName: null,
    reservedUntil: BO_UNTIL,
  },
});
