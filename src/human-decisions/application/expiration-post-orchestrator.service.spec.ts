/** INACTIVE EXPIRATION POST orchestrator — essential tests (O-T1a): mocked
 * store + client only, no DI/HTTP/DB/runtime. O-T1b cases (adversarial, identity, CAS-fencing) are deferred in odd/tasks/expiration-post-orchestrator-tests.pending.patch */
import { ExpirationPostOrchestrator } from './expiration-post-orchestrator.service';
import type { ExpirationIntakeReceipt } from '../../chatbot-api/domain/dtos/human-decisions-expiration-receipt.dto';
import type { ExpirationPostDecision } from '../domain/expiration-post-ledger';
import type { ExpirationPrepareDecision } from '../infrastructure/postgres-expiration-post-claim.store';

const SENDER = 'whatsapp:+5215500000001';
const REQUEST_ID = 'a1b2c3d4-e5f6-1a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT_ID = '99999999-9999-4999-8999-999999999999';
const BACKEND_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INTAKE = {
  sourceRequestId: REQUEST_ID,
  type: 'EXPIRATION' as const,
  productId: PRODUCT_ID,
  variantId: null,
};
const input = () => ({
  senderId: SENDER,
  sourceRequestId: REQUEST_ID,
  intake: { ...INTAKE },
});

function receipt(overrides?: { id?: string; sourceRequestId?: string }) {
  return {
    id: overrides?.id ?? BACKEND_ID,
    sourceRequestId: overrides?.sourceRequestId ?? REQUEST_ID,
    type: 'EXPIRATION',
    status: 'PENDING',
    version: 1,
    createdAt: '2026-06-22T12:00:00.000Z',
    snapshot: {
      branchId: 'branch-1',
      branchName: 'Sucursal Centro',
      productId: PRODUCT_ID,
      productName: 'Collar',
      unit: 'pieza',
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    },
    supersedesDecisionId: null,
    resolution: null,
    applyBefore: null,
  } satisfies ExpirationIntakeReceipt;
}

function build(
  parts: {
    prepare?: () => Promise<ExpirationPrepareDecision>;
    begin?: () => Promise<ExpirationPostDecision>;
    record?: () => Promise<ExpirationPostDecision>;
    markUnknown?: () => Promise<ExpirationPostDecision>;
    submit?: () => Promise<ExpirationIntakeReceipt>;
  } = {},
) {
  const store: Record<
    'preparePost' | 'beginPost' | 'recordReceipt' | 'markUnknown',
    jest.Mock
  > = {
    preparePost: jest.fn(
      parts.prepare ?? (async () => ({ action: 'prepared' as const })),
    ),
    beginPost: jest.fn(
      parts.begin ?? (async () => ({ action: 'authorize_post' as const })),
    ),
    recordReceipt: jest.fn(
      parts.record ??
        (async () => ({
          action: 'record_receipt' as const,
          backendDecisionId: BACKEND_ID,
        })),
    ),
    markUnknown: jest.fn(
      parts.markUnknown ??
        (async () => ({ action: 'blocked' as const, reason: 'unconfigured' })),
    ),
  };
  const client = {
    submitExpirationIntake: jest.fn(parts.submit ?? (async () => receipt())),
  };
  const orchestrator = new ExpirationPostOrchestrator(store, client);
  return { orchestrator, store, client };
}

const hold = (
  reason: 'pre_post' | 'ambiguous_post',
): ExpirationPostDecision => ({ action: 'mark_unknown', reason });
const boom = (): Promise<never> => Promise.reject(new Error('injected'));

describe('ExpirationPostOrchestrator', () => {
  it('happy path: prepare -> claim -> one POST -> receipt persisted', async () => {
    const { orchestrator, store, client } = build();
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({
      action: 'receipt_recorded',
      backendDecisionId: BACKEND_ID,
    });
    expect(store.preparePost).toHaveBeenCalledTimes(1);
    expect(client.submitExpirationIntake).toHaveBeenCalledTimes(1);
    expect(store.markUnknown).not.toHaveBeenCalled();
    expect(store.recordReceipt).toHaveBeenCalledWith({
      senderId: SENDER,
      sourceRequestId: REQUEST_ID,
      intake: INTAKE,
      backendDecisionId: BACKEND_ID,
    });
  });

  it('concurrent orchestration: exactly one winner POSTs, the loser holds', async () => {
    let claims = 0;
    const { orchestrator, client } = build({
      begin: async () =>
        ++claims === 1
          ? { action: 'authorize_post' }
          : { action: 'hold', reason: 'post_in_flight' },
    });
    const outcomes = await Promise.all([
      orchestrator.orchestrateExpirationPost(input()),
      orchestrator.orchestrateExpirationPost(input()),
    ]);
    expect(client.submitExpirationIntake).toHaveBeenCalledTimes(1);
    expect(outcomes).toContainEqual({
      action: 'receipt_recorded',
      backendDecisionId: BACKEND_ID,
    });
    expect(outcomes).toContainEqual({
      action: 'hold',
      reason: 'post_in_flight',
    });
  });

  it('POST timeout: exactly one attempt, conservative hold, no resend', async () => {
    const { orchestrator, store, client } = build({
      submit: boom,
      markUnknown: async () => hold('ambiguous_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
    expect(client.submitExpirationIntake).toHaveBeenCalledTimes(1);
    expect(store.recordReceipt).not.toHaveBeenCalled();
  });

  it('persistence throw with markUnknown failure stays blocked (no UNKNOWN fabricated)', async () => {
    const { orchestrator, store } = build({ record: boom, markUnknown: boom });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({
      action: 'blocked',
      reason: 'receipt_persist_unconfirmed',
    });
    expect(store.recordReceipt).toHaveBeenCalledTimes(1);
  });

  it('non-canonical uppercase backend id is rejected without lowercasing', async () => {
    const { orchestrator, store } = build({
      submit: async () => receipt({ id: BACKEND_ID.toUpperCase() }),
      markUnknown: async () => hold('ambiguous_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
    expect(store.recordReceipt).not.toHaveBeenCalled();
  });
});
