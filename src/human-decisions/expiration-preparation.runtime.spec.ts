import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { ChatbotApiClient } from '../chatbot-api/domain/chatbot-api.client';
import type { WhatsappSenderPort } from '../whatsapp/domain/whatsapp-sender.port';
import { ExpirationPreparationRuntime } from './expiration-preparation.runtime';
import { ExpirationRecoveryPoller } from './application/expiration-recovery-poller';
import { ExpirationExistingDecisionService } from './application/expiration-existing-decision.service';
import {
  normalizeExpirationApplicationLedgerRow,
  type ExpirationApplicationLedgerRow,
} from './domain/expiration-application-ledger-row';
import { deriveExpirationAttemptId } from './domain/expiration-attempt-identity';
import { PostgresExpirationRecoveryDiscoveryStore } from './infrastructure/postgres-expiration-recovery-discovery.store';
import { PostgresExpirationApplicationPreparationStore } from './infrastructure/postgres-expiration-application-preparation.store';
import { PostgresExpirationApplicationClaimStore } from './infrastructure/postgres-expiration-application-claim.store';
import { PostgresExpirationApplicationLedgerStore } from './infrastructure/postgres-expiration-application-ledger.store';
import { PostgresCustomerInboundObservationStore } from './infrastructure/postgres-customer-inbound-observation.store';

const senderId = 'customer';
const branchId = 'branch';
const phone = '123456';
const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const productId = '44444444-4444-4444-8444-444444444444';
const sendToken = '11111111-1111-4111-8111-111111111111';
const resolvedAt = '2026-06-23T08:00:00.000Z';
const applyBefore = '2026-06-24T08:00:00.000Z';
const observedAt = '2026-06-23T08:59:00.000Z';
const now = '2026-06-23T09:00:00.000Z';
const attemptId = deriveExpirationAttemptId(
  sourceRequestId,
  decisionId,
) as string;
const startedExtras = { sendToken, attemptedAt: observedAt };
const resolvedOutcome = {
  outcome: 'resolved' as const,
  binding: {
    branchId,
    backendDecisionId: decisionId,
    postAttemptedAt: '2026-06-23T07:58:00.000Z',
    receiptRecordedAt: '2026-06-23T07:59:00.000Z',
    reservation: {
      status: 'ACTIVE' as const,
      route: 'EXPIRATION' as const,
      senderId,
      requestKey: sourceRequestId,
      intake: {
        sourceRequestId,
        type: 'EXPIRATION' as const,
        productId,
        variantId: null,
      },
    },
  },
  decision: {
    id: decisionId,
    sourceRequestId,
    type: 'EXPIRATION' as const,
    status: 'RESOLVED' as const,
    version: 2 as const,
    createdAt: resolvedAt,
    snapshot: {
      branchId,
      branchName: null,
      productId,
      productName: 'Original food',
      unit: 'PZA',
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    },
    supersedesDecisionId: null,
    resolution: {
      action: 'PROVIDE_EXPIRATION_TEXT' as const,
      expirationText: 'Marzo de 2027',
      resolvedAt,
    },
    applyBefore,
  },
};
function fixture<T extends ExpirationApplicationLedgerRow['state']>(
  state: T,
  extra: Record<string, unknown> = {},
): Extract<ExpirationApplicationLedgerRow, { state: T }> {
  const value = normalizeExpirationApplicationLedgerRow({
    state,
    senderId,
    branchId,
    sourceRequestId,
    decisionId,
    resolutionVersion: 2,
    attemptId,
    resolvedAt,
    applyBefore,
    ...extra,
  });
  if (!value || value.state !== state) throw new Error('ledger fixture');
  return value as Extract<ExpirationApplicationLedgerRow, { state: T }>;
}
function compose() {
  const discovery = jest
    .spyOn(
      PostgresExpirationRecoveryDiscoveryStore.prototype,
      'discoverRecordedHints',
    )
    .mockResolvedValue({
      action: 'page',
      hints: [{ senderId, requestKey: sourceRequestId }],
      nextCursor: null,
    });
  const decisions = jest
    .spyOn(ExpirationExistingDecisionService.prototype, 'readExistingDecision')
    .mockResolvedValue(resolvedOutcome);
  const preparation = jest
    .spyOn(
      PostgresExpirationApplicationPreparationStore.prototype,
      'preparePending',
    )
    .mockResolvedValue({
      action: 'prepared',
      row: fixture('PENDING_DELIVERY'),
    });
  const claim = jest
    .spyOn(PostgresExpirationApplicationClaimStore.prototype, 'claimPending')
    .mockResolvedValue({
      action: 'claimed',
      row: fixture('SEND_STARTED', startedExtras),
    });
  const latest = jest
    .spyOn(PostgresCustomerInboundObservationStore.prototype, 'readLatest')
    .mockResolvedValue({
      kind: 'found',
      observation: {
        senderId,
        receivingPhoneNumberId: phone,
        messageId: 'later-wamid',
        providerTimestampSeconds: String(Date.parse(observedAt) / 1000),
        observedAt,
      },
    });
  const acceptance = jest
    .spyOn(
      PostgresExpirationApplicationLedgerStore.prototype,
      'recordAcceptance',
    )
    .mockResolvedValue({
      action: 'updated',
      row: fixture('PROVIDER_ACCEPTED', {
        ...startedExtras,
        providerMessageId: 'wamid.accepted',
        providerAcceptedObservedAt: now,
      }),
    });
  return { discovery, decisions, preparation, claim, latest, acceptance };
}

describe('ExpirationPreparationRuntime', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  function build(
    enabled: unknown,
    branch: unknown = branchId,
    phoneValue: unknown = phone,
    sender: Pick<WhatsappSenderPort, 'sendText'> = { sendText: jest.fn() },
  ) {
    const config = {
      get: (key: string) =>
        key === 'minimalCatalogAgent.expirationEnabled'
          ? enabled
          : key === 'meta.phoneNumberId'
            ? phoneValue
            : branch,
    } as ConfigService;
    return new ExpirationPreparationRuntime(
      config,
      {} as Pool,
      {} as ChatbotApiClient,
      sender,
    );
  }
  it.each([false, undefined, 'true'])(
    'does not start with gate %s',
    async (enabled) => {
      const start = jest
        .spyOn(ExpirationRecoveryPoller.prototype, 'start')
        .mockImplementation();
      const runtime = build(enabled);
      runtime.onApplicationBootstrap();
      expect(start).not.toHaveBeenCalled();
      await runtime.onModuleDestroy();
    },
  );
  it('starts once with a valid branch and drains the poller on shutdown', async () => {
    const start = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'start')
      .mockImplementation();
    const stop = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'stop')
      .mockResolvedValue();
    const runtime = build(true);
    runtime.onApplicationBootstrap();
    runtime.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
    await runtime.onModuleDestroy();
    runtime.onApplicationBootstrap();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('rejects missing branch identity before starting', () => {
    const start = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'start')
      .mockImplementation();
    expect(() => build(true, '').onApplicationBootstrap()).toThrow(
      'EXPIRATION preparation requires branch identity',
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('requires the receiving phone identity before starting the enabled runtime', () => {
    const start = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'start')
      .mockImplementation();
    expect(() => build(true, branchId, '   ').onApplicationBootstrap()).toThrow(
      'EXPIRATION runtime requires the Meta receiving phone identity',
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('stays inert when disabled even without a phone identity', async () => {
    const start = jest
      .spyOn(ExpirationRecoveryPoller.prototype, 'start')
      .mockImplementation();
    const sender = { sendText: jest.fn() };
    const runtime = build(false, branchId, '', sender);
    runtime.onApplicationBootstrap();
    expect(start).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
    await runtime.onModuleDestroy();
  });
  it('sends the historical reply with the configured receiving phone and records acceptance', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));
    const spies = compose();
    const sender = {
      sendText: jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'wamid.accepted' }),
    };
    const runtime = build(true, branchId, phone, sender);
    runtime.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(spies.preparation).toHaveBeenCalledTimes(1);
    expect(spies.claim).toHaveBeenCalledTimes(1);
    expect(spies.latest).toHaveBeenCalledWith(senderId, phone);
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    const [[message]] = sender.sendText.mock.calls as unknown as [
      [{ to: string; text: string }],
    ];
    expect(message.to).toBe(senderId);
    expect(message.text).toContain('Original food');
    expect(spies.acceptance).toHaveBeenCalledTimes(1);
    await runtime.onModuleDestroy();
  });
});
