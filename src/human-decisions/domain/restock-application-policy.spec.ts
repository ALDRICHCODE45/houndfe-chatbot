import { classifyRestockApplication } from './restock-application-policy';

const S = 'whatsapp:+5215500000001';
const B = '11111111-1111-4111-8111-111111111111';
const SRC = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const DID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = '99999999-9999-4999-8999-999999999999';
const NAME = 'Collar premium';
const RA = '2026-06-22T12:00:00.000Z';
const AB = '2026-06-22T13:00:00.000Z';
const G = 'a8c9e2cf-338e-50ad-a49b-3de5a82e4e8e';

const SUBJ = {
  productId: '22222222-2222-4222-8222-222222222222',
  productName: NAME,
  variantId: '33333333-3333-4333-8333-333333333333',
  sku: 'SKU-1',
  requestedQuantity: 2,
  observedStockAtRequest: 0,
  stockObservedAt: '2026-06-22T11:00:00.000Z',
};
const RES = {
  status: 'ACTIVE',
  route: 'RESTOCK',
  senderId: S,
  requestKey: SRC,
  intake: {
    sourceRequestId: SRC,
    type: 'RESTOCK',
    ...SUBJ,
    supersedesDecisionId: null,
  },
};
const SNAP = { branchId: B, branchName: 'Centro', ...SUBJ };
const dec = (o: Record<string, unknown> = {}) => ({
  id: DID,
  sourceRequestId: SRC,
  type: 'RESTOCK',
  createdAt: '2026-06-22T10:00:00.000Z',
  snapshot: SNAP,
  supersedesDecisionId: null,
  ...o,
});
const PEND = dec({
  status: 'PENDING',
  version: 1,
  resolution: null,
  applyBefore: null,
});
const POS = dec({
  status: 'RESOLVED',
  version: 2,
  resolution: {
    action: 'PROVIDE_RESTOCK_ESTIMATE',
    restockDays: 3,
    resolvedAt: RA,
  },
  applyBefore: AB,
});
const NEG = dec({
  status: 'RESOLVED',
  version: 2,
  resolution: {
    action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
    resolvedAt: RA,
  },
  applyBefore: AB,
});
const inp = (o: Record<string, unknown> = {}) => ({
  senderId: S,
  branchId: B,
  reservation: RES,
  backendDecisionId: DID,
  decision: POS,
  now: RA,
  ...o,
});

describe('classifyRestockApplication', () => {
  const ready = { action: 'ready', attemptId: G, decisionId: DID };
  const stale = { action: 'stale', attemptId: G, decisionId: DID };
  const res = (o: Record<string, unknown>) => ({
    ...RES,
    intake: { ...RES.intake, ...o },
  });
  const noSupersedes: Record<string, unknown> = { ...RES.intake };
  delete noSupersedes.supersedesDecisionId;
  const accessorIntake = Object.defineProperty({ ...RES.intake }, 'sku', {
    get: () => SUBJ.sku,
  });

  it('maps PENDING to pending and both resolutions to ready in window', () => {
    expect(classifyRestockApplication(inp({ decision: PEND }))).toEqual({
      action: 'pending',
    });
    expect(classifyRestockApplication(inp())).toEqual(ready);
    expect(classifyRestockApplication(inp({ decision: NEG }))).toEqual(ready);
  });

  it('uses the half-open boundaries and holds invalid clocks', () => {
    expect(classifyRestockApplication(inp({ now: RA }))).toEqual(ready);
    expect(classifyRestockApplication(inp({ now: AB }))).toEqual(stale);
    for (const now of [
      '',
      'x',
      '2026-06-22',
      '2026-06-22T12:00:00Z',
      '2026-06-22T12:00:00.000+00:00',
      1,
      null,
      undefined,
    ]) {
      expect(classifyRestockApplication(inp({ now }))).toEqual({
        action: 'hold',
        reason: 'invalid_clock',
      });
    }
    expect(
      classifyRestockApplication(inp({ now: '2026-06-22T11:59:59.999Z' })),
    ).toEqual({ action: 'hold', reason: 'clock_before_resolution' });
  });

  it('holds every mismatched binding and never stales it after expiry', () => {
    for (const over of [
      { senderId: 'whatsapp:+5215500000999' },
      { branchId: OTHER },
      { backendDecisionId: OTHER },
      { decision: { ...POS, sourceRequestId: OTHER } },
      { reservation: { ...RES, requestKey: OTHER } },
      { decision: { ...POS, snapshot: { ...SNAP, productId: OTHER } } },
      { decision: { ...POS, snapshot: { ...SNAP, variantId: null } } },
      { decision: { ...POS, snapshot: { ...SNAP, productName: 'Otro' } } },
      { decision: { ...POS, snapshot: { ...SNAP, sku: 'SKU-2' } } },
      { decision: { ...POS, supersedesDecisionId: OTHER } },
      { reservation: res({ supersedesDecisionId: OTHER }) },
      {
        reservation: res({ supersedesDecisionId: DID }),
        decision: { ...POS, supersedesDecisionId: OTHER },
      },
      { reservation: res({ productName: `  ${NAME}  ` }) },
      { reservation: res({ productName: NAME.replace(' ', '  ') }) },
      { reservation: res({ supersedesDecisionId: undefined }) },
      { reservation: { ...RES, intake: noSupersedes } },
    ]) {
      expect(classifyRestockApplication(inp(over)).action).toBe('hold');
    }
    const lineage = inp({
      reservation: res({ supersedesDecisionId: DID.toUpperCase() }),
      decision: { ...POS, supersedesDecisionId: DID },
    });
    expect(classifyRestockApplication(lineage)).toEqual(ready);
    expect(
      classifyRestockApplication(inp({ now: AB, branchId: OTHER })),
    ).toEqual({ action: 'hold', reason: 'branch_mismatch' });
    expect(JSON.stringify(ready)).not.toMatch(
      /deliver|notif|applied|sent|message/i,
    );
  });

  it('fails closed on malformed or hostile input without throwing', () => {
    const accessor = {} as Record<string, unknown>;
    for (const [k, v] of Object.entries(inp())) {
      Object.defineProperty(accessor, k, { get: () => v, enumerable: true });
    }
    for (const value of [
      undefined,
      null,
      {},
      { ...inp(), extra: 1 },
      accessor,
      new Proxy(inp(), { get: () => 'tampered' }),
      { ...inp(), reservation: 'unknown' },
      { ...inp(), backendDecisionId: null },
      { ...inp(), reservation: { ...RES, intake: accessorIntake } },
    ]) {
      expect(() => classifyRestockApplication(value)).not.toThrow();
      expect(classifyRestockApplication(value).action).toBe('hold');
    }
  });
});
