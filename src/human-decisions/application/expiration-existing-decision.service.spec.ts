import { ExpirationExistingDecisionService } from './expiration-existing-decision.service';

/**
 * INACTIVE EXPIRATION reader->GET composition (mocked ports: no DI/HTTP/DB/
 * runtime). It reads the recorded receipt, queries ONLY the persisted decision
 * id, and validates origin, branch, product and variant without folding bytes.
 * A RESOLVED past its deadline is still resolved: no send-eligibility claim.
 */
const SENDER = 'whatsapp:+5215500000001';
const BRANCH = 'sucursal-centro';
const SRC = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const OTHER = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const AT = '2026-06-23T08:00:00.000Z';
const BEFORE = '2026-06-24T08:00:00.000Z';

type Over = Record<string, unknown>;
const intake = (o: Over = {}) => ({
  sourceRequestId: SRC,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: VARIANT,
  ...o,
});
const context = (o: Over = {}) => ({
  reservation: {
    status: 'ACTIVE',
    route: 'EXPIRATION',
    senderId: SENDER,
    requestKey: SRC,
    intake: intake(),
  },
  backendDecisionId: ID,
  ...o,
});
const snapshot = (o: Over = {}) => ({
  branchId: BRANCH,
  branchName: 'Centro',
  productId: PRODUCT,
  productName: 'Croquetas',
  unit: 'PZA',
  variantId: VARIANT,
  variantName: 'Senior',
  variantOption: 'Tamaño',
  variantValue: '15 kg',
  ...o,
});
const decision = (o: Over = {}) => ({
  id: ID,
  sourceRequestId: SRC,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: AT,
  snapshot: snapshot(),
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
  ...o,
});
const provided = (o: Over = {}) => ({
  action: 'PROVIDE_EXPIRATION_TEXT',
  expirationText: 'Vence 03/2027',
  resolvedAt: AT,
  ...o,
});
const notAvailable = (o: Over = {}) => ({
  action: 'REPORT_EXPIRATION_UNAVAILABLE',
  resolvedAt: AT,
  ...o,
});
const resolved = (resolution: unknown, o: Over = {}) =>
  decision({
    status: 'RESOLVED',
    version: 2,
    resolution,
    applyBefore: BEFORE,
    ...o,
  });

function setup(
  o: {
    read?: unknown;
    decision?: unknown;
    branch?: string;
    failRead?: boolean;
  } = {},
) {
  const readRecordedForSender: jest.Mock = jest
    .fn()
    .mockResolvedValue(
      'read' in o ? o.read : { action: 'recorded', context: context() },
    );
  const getExpirationDecision: jest.Mock = jest
    .fn()
    .mockResolvedValue('decision' in o ? o.decision : decision());
  if (o.failRead) readRecordedForSender.mockRejectedValue(new Error('db'));
  return {
    service: new ExpirationExistingDecisionService(
      { readRecordedForSender },
      { getExpirationDecision },
      o.branch ?? BRANCH,
    ),
    readRecordedForSender,
    getExpirationDecision,
  };
}
const ask = (f: ReturnType<typeof setup>, senderId = SENDER) =>
  f.service.readExistingDecision(senderId);
const held = { outcome: 'held' };
const failed = { outcome: 'query_failed' };

describe('ExpirationExistingDecisionService', () => {
  it('reports pending from a validated GET keyed only by the persisted id', async () => {
    const f = setup();
    await expect(ask(f)).resolves.toEqual({
      outcome: 'pending',
      decision: decision(),
    });
    expect(f.readRecordedForSender).toHaveBeenCalledWith(SENDER);
    expect(f.getExpirationDecision).toHaveBeenCalledWith(ID);
  });

  it('reports resolved for both typed actions with a detached decision', async () => {
    for (const resolution of [provided(), notAvailable()]) {
      const action = resolution.action;
      const wire = resolved(resolution);
      const result = await ask(setup({ decision: wire }));
      expect(result).toEqual({ outcome: 'resolved', decision: wire });
      if (result.outcome !== 'resolved') throw new Error('unreachable');
      wire.snapshot.branchId = 'mutated';
      (wire.resolution as unknown as { action: string }).action = 'mutated';
      expect(result.decision.snapshot.branchId).toBe(BRANCH);
      expect(result.decision.resolution.action).toBe(action);
    }
  });

  it.each([
    undefined,
    null,
    { action: 'missing' },
    { action: 'hold' },
    { action: 'recorded' },
    { action: 'recorded', context: null },
  ])('held with no GET for an unrecorded receipt (%#)', async (read) => {
    const f = setup({ read });
    await expect(ask(f)).resolves.toEqual(held);
    expect(f.getExpirationDecision).not.toHaveBeenCalled();
  });

  it('query_failed with no GET when the receipt reader throws', async () => {
    const f = setup({ failRead: true });
    await expect(ask(f)).resolves.toEqual(failed);
    expect(f.getExpirationDecision).not.toHaveBeenCalled();
  });

  it('query_failed when the returned decision id does not bind to the queried id', async () => {
    const f = setup({ decision: decision({ id: OTHER }) });
    await expect(ask(f)).resolves.toEqual(failed);
    expect(f.getExpirationDecision).toHaveBeenCalledWith(ID);
  });

  it.each([
    ['source', decision({ sourceRequestId: OTHER })],
    ['branch', decision({ snapshot: snapshot({ branchId: 'other' }) })],
    ['product', decision({ snapshot: snapshot({ productId: OTHER }) })],
    [
      'variant',
      decision({
        snapshot: snapshot({ variantId: OTHER, variantName: 'Otra' }),
      }),
    ],
  ])(
    'held when the decision %s does not bind to the persisted record',
    async (_label, wire) => {
      await expect(ask(setup({ decision: wire }))).resolves.toEqual(held);
    },
  );

  it('binds a null persisted variant exactly', async () => {
    const noVariant = context({
      reservation: {
        ...context().reservation,
        intake: intake({ variantId: null }),
      },
    });
    const blank = snapshot({
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    });
    const read = { action: 'recorded', context: noVariant };
    await expect(
      ask(setup({ read, decision: decision({ snapshot: blank }) })),
    ).resolves.toEqual({
      outcome: 'pending',
      decision: decision({ snapshot: blank }),
    });
    await expect(ask(setup({ read, decision: decision() }))).resolves.toEqual(
      held,
    );
  });

  it('does not fold source case: uppercase persisted vs lowercase GET is held', async () => {
    const upper = SRC.toUpperCase();
    const f = setup({
      read: {
        action: 'recorded',
        context: context({
          reservation: {
            ...context().reservation,
            requestKey: upper,
            intake: intake({ sourceRequestId: upper }),
          },
        }),
      },
      decision: decision({ sourceRequestId: SRC }),
    });
    await expect(ask(f)).resolves.toEqual(held);
    expect(f.getExpirationDecision).toHaveBeenCalledWith(ID);
  });
});
