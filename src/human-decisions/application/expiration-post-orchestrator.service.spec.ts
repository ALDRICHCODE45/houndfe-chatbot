/** INACTIVE EXPIRATION POST orchestrator tests (O1/O2): mocked store + client
 * only — no DI, HTTP, DB or runtime. Fake CAS concurrency is composition-level
 * evidence, not a new database proof. */
import { ExpirationPostOrchestrator } from './expiration-post-orchestrator.service';
import type { ExpirationIntakeReceipt } from '../../chatbot-api/domain/dtos/human-decisions-expiration-receipt.dto';
import type { ExpirationPostDecision } from '../domain/expiration-post-ledger';
import type { ExpirationPrepareDecision } from '../infrastructure/postgres-expiration-post-claim.store';

const SENDER = 'whatsapp:+5215500000001';
const REQUEST_ID = 'a1b2c3d4-e5f6-1a7b-8c9d-0e1f2a3b4c5d';
const PRODUCT_ID = '99999999-9999-4999-8999-999999999999';
const BACKEND_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const INTAKE = {
  sourceRequestId: REQUEST_ID,
  type: 'EXPIRATION' as const,
  productId: PRODUCT_ID,
  variantId: null,
};
const input = (): {
  senderId: string;
  sourceRequestId: string;
  intake: {
    sourceRequestId: string;
    type: string;
    productId: string;
    variantId: string | null;
  };
} => ({ senderId: SENDER, sourceRequestId: REQUEST_ID, intake: { ...INTAKE } });

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

type Parts = {
  prepare?: () => Promise<ExpirationPrepareDecision>;
  begin?: () => Promise<ExpirationPostDecision>;
  record?: () => Promise<ExpirationPostDecision>;
  markUnknown?: () => Promise<ExpirationPostDecision>;
  submit?: () => Promise<ExpirationIntakeReceipt>;
};
type StoreMock = {
  preparePost: jest.Mock;
  beginPost: jest.Mock;
  recordReceipt: jest.Mock;
  markUnknown: jest.Mock;
};

function build(parts: Parts = {}) {
  const store: StoreMock = {
    preparePost: jest.fn(
      parts.prepare ??
        (async (): Promise<ExpirationPrepareDecision> => ({
          action: 'prepared',
        })),
    ),
    beginPost: jest.fn(
      parts.begin ??
        (async (): Promise<ExpirationPostDecision> => ({
          action: 'authorize_post',
        })),
    ),
    recordReceipt: jest.fn(
      parts.record ??
        (async (): Promise<ExpirationPostDecision> => ({
          action: 'record_receipt',
          backendDecisionId: BACKEND_ID,
        })),
    ),
    markUnknown: jest.fn(
      parts.markUnknown ??
        (async (): Promise<ExpirationPostDecision> => ({
          action: 'blocked',
          reason: 'unconfigured',
        })),
    ),
  };
  const client = {
    submitExpirationIntake: jest.fn(
      parts.submit ?? (async (): Promise<ExpirationIntakeReceipt> => receipt()),
    ) as jest.Mock,
  };
  return {
    orchestrator: new ExpirationPostOrchestrator(store, client),
    store,
    client,
  };
}

const hold = (
  reason: 'pre_post' | 'ambiguous_post',
): ExpirationPostDecision => ({
  action: 'mark_unknown',
  reason,
});
const boom = async (): Promise<never> => {
  throw new Error('injected');
};

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

  it('already_prepared still claims and records', async () => {
    const { orchestrator, store } = build({
      prepare: async () => ({ action: 'already_prepared' }),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({
      action: 'receipt_recorded',
      backendDecisionId: BACKEND_ID,
    });
    expect(store.beginPost).toHaveBeenCalledTimes(1);
  });

  it('prepare blocked never reaches authority: no POST, no markUnknown', async () => {
    const { orchestrator, store, client } = build({
      prepare: async () => ({ action: 'blocked', reason: 'missing_row' }),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'blocked', reason: 'prepare_missing_row' });
    expect(store.beginPost).not.toHaveBeenCalled();
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
    expect(store.markUnknown).not.toHaveBeenCalled();
  });

  it('prepare throw with confirmed markUnknown holds pre_post before any POST', async () => {
    const { orchestrator, store, client } = build({
      prepare: boom,
      markUnknown: async () => hold('pre_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'pre_post' });
    expect(store.beginPost).not.toHaveBeenCalled();
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
  });

  it('prepare throw with markUnknown failure stays honestly blocked', async () => {
    const { orchestrator, store, client } = build({
      prepare: boom,
      markUnknown: boom,
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'blocked', reason: 'prepare_unconfirmed' });
    expect(store.beginPost).not.toHaveBeenCalled();
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
  });

  it('claim hold (another actor in flight): hold, no resend, no markUnknown', async () => {
    const { orchestrator, store, client } = build({
      begin: async () => ({ action: 'hold', reason: 'post_in_flight' }),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'hold', reason: 'post_in_flight' });
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
    expect(store.markUnknown).not.toHaveBeenCalled();
  });

  it('claim historical receipt is returned verbatim, never re-POSTed', async () => {
    const { orchestrator, client } = build({
      begin: async () => ({
        action: 'historical_receipt',
        backendDecisionId: OTHER_ID,
      }),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({
      action: 'historical_receipt',
      backendDecisionId: OTHER_ID,
    });
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
  });

  it('claim throw with confirmed markUnknown holds ambiguous_post', async () => {
    const { orchestrator, client } = build({
      begin: boom,
      markUnknown: async () => hold('ambiguous_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
  });

  it('claim blocked unknown_state fail-closes through markUnknown', async () => {
    const { orchestrator, client } = build({
      begin: async () => ({ action: 'blocked', reason: 'unknown_state' }),
      markUnknown: async () => hold('ambiguous_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
  });

  it('claim blocked missing_row stays blocked without markUnknown', async () => {
    const { orchestrator, store, client } = build({
      begin: async () => ({ action: 'blocked', reason: 'missing_row' }),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'blocked', reason: 'claim_missing_row' });
    expect(client.submitExpirationIntake).not.toHaveBeenCalled();
    expect(store.markUnknown).not.toHaveBeenCalled();
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

  it('POST timeout with markUnknown failure never fabricates UNKNOWN', async () => {
    const { orchestrator, client } = build({ submit: boom, markUnknown: boom });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'blocked', reason: 'post_unconfirmed' });
    expect(client.submitExpirationIntake).toHaveBeenCalledTimes(1);
  });

  it('receipt not binding to the original input fail-closes before record', async () => {
    const { orchestrator, store } = build({
      submit: async () => receipt({ sourceRequestId: OTHER_ID }),
      markUnknown: async () => hold('ambiguous_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
    expect(store.recordReceipt).not.toHaveBeenCalled();
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

  it('persistence throw with confirmed markUnknown holds, never labels recorded', async () => {
    const { orchestrator, store } = build({
      record: boom,
      markUnknown: async () => hold('ambiguous_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
    expect(store.recordReceipt).toHaveBeenCalledTimes(1);
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

  it('concurrent winner replays the same backend id as replayed', async () => {
    const { orchestrator } = build({
      record: async () => ({
        action: 'replay_receipt',
        backendDecisionId: BACKEND_ID,
      }),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({
      action: 'receipt_replayed',
      backendDecisionId: BACKEND_ID,
    });
  });

  it('a different stored backend id conflicts and blocks without markUnknown', async () => {
    const { orchestrator, store } = build({
      record: async () => ({
        action: 'conflict',
        storedBackendDecisionId: OTHER_ID,
      }),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({
      action: 'blocked',
      reason: `receipt_conflict_${OTHER_ID}`,
    });
    expect(store.markUnknown).not.toHaveBeenCalled();
  });

  it('record blocked unknown_state fail-closes through markUnknown', async () => {
    const { orchestrator } = build({
      record: async () => ({ action: 'blocked', reason: 'unknown_state' }),
      markUnknown: async () => hold('ambiguous_post'),
    });
    await expect(
      orchestrator.orchestrateExpirationPost(input()),
    ).resolves.toEqual({ action: 'held_unknown', reason: 'ambiguous_post' });
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

  it.each([
    ['extra key', { ...input(), extra: 1 }],
    ['missing intake key', { senderId: SENDER, sourceRequestId: REQUEST_ID }],
    ['non-uuid sourceRequestId', { ...input(), sourceRequestId: 'not-a-uuid' }],
    [
      'intake not bound to the request id',
      { ...input(), intake: { ...INTAKE, sourceRequestId: OTHER_ID } },
    ],
    ['null input', null],
  ])(
    'malformed input (%s): blocked before any store or HTTP call',
    async (_n, raw) => {
      const { orchestrator, store, client } = build();
      await expect(
        orchestrator.orchestrateExpirationPost(raw),
      ).resolves.toEqual({ action: 'blocked', reason: 'malformed_input' });
      expect(store.preparePost).not.toHaveBeenCalled();
      expect(client.submitExpirationIntake).not.toHaveBeenCalled();
    },
  );

  it('getter descriptors on the intake fail closed', async () => {
    const raw = input();
    Object.defineProperty(raw.intake, 'productId', {
      get: () => PRODUCT_ID,
      enumerable: true,
    });
    const { orchestrator, store } = build();
    await expect(orchestrator.orchestrateExpirationPost(raw)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(store.preparePost).not.toHaveBeenCalled();
  });

  it('source UUID case is preserved byte-for-byte to store and client', async () => {
    const upperRequest = REQUEST_ID.toUpperCase();
    const upperProduct = PRODUCT_ID.toUpperCase();
    const { orchestrator, store, client } = build();
    await orchestrator.orchestrateExpirationPost({
      senderId: SENDER,
      sourceRequestId: upperRequest,
      intake: {
        sourceRequestId: upperRequest,
        type: 'EXPIRATION',
        productId: upperProduct,
        variantId: null,
      },
    });
    const prepareArg = (store.preparePost.mock.calls as unknown[][])[0][0] as {
      sourceRequestId: string;
      intake: { sourceRequestId: string; productId: string };
    };
    expect(prepareArg.sourceRequestId).toBe(upperRequest);
    expect(prepareArg.intake).toMatchObject({
      sourceRequestId: upperRequest,
      productId: upperProduct,
    });
    expect(
      (client.submitExpirationIntake.mock.calls as unknown[][])[0][0],
    ).toMatchObject({
      sourceRequestId: upperRequest,
      productId: upperProduct,
    });
  });

  it('input is snapshotted and copied before the first await', async () => {
    const { orchestrator, store } = build();
    const raw = input();
    const pending = orchestrator.orchestrateExpirationPost(raw);
    raw.intake.productId = 'mutated-after-call';
    raw.senderId = 'mutated-after-call';
    await expect(pending).resolves.toEqual({
      action: 'receipt_recorded',
      backendDecisionId: BACKEND_ID,
    });
    const prepareArg = (store.preparePost.mock.calls as unknown[][])[0][0] as {
      senderId: string;
      intake: { productId: string };
    };
    expect(prepareArg.senderId).toBe(SENDER);
    expect(prepareArg.intake.productId).toBe(PRODUCT_ID);
  });
});
