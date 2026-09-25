import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  RestockIntakeInput,
  RestockIntakeReceipt,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type { RestockPostLedgerPort } from '../domain/restock-post-ledger';
import type { SharedReservationPort } from '../domain/shared-reservation';
import { RestockIntakeService } from './restock-intake.service';

/**
 * R3b3-c4 core behavior spec for the inert bot-only RESTOCK intake coordinator.
 * Real fake ports stand in for reservation/ledger/backend; no external call is
 * made. `sourceRequestId` is caller-owned: the service normalizes it and never
 * mints a new id, and the returned key is a HISTORICAL poll key, never current
 * state or device delivery. Adversarial/negative cases live in the adversarial
 * spec.
 */
const SENDER = 'whatsapp:+5215500000001';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const DECISION = '33333333-3333-4333-8333-333333333333';
const BRANCH = '44444444-4444-4444-8444-444444444444';
const CREATED = '2026-06-23T12:00:00.000Z';

const intake = (o: Partial<RestockIntakeInput> = {}): RestockIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: 'Alimento premium',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
  ...o,
});
const receiptFor = (i: RestockIntakeInput): RestockIntakeReceipt => ({
  id: DECISION,
  sourceRequestId: i.sourceRequestId,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: CREATED,
  snapshot: {
    branchId: BRANCH,
    branchName: null,
    productId: i.productId,
    productName: i.productName,
    variantId: i.variantId,
    sku: i.sku,
    requestedQuantity: i.requestedQuantity,
    observedStockAtRequest: i.observedStockAtRequest,
    stockObservedAt: i.stockObservedAt,
  },
  supersedesDecisionId: i.supersedesDecisionId,
  resolution: null,
  applyBefore: null,
});

const build = () => {
  const reservations = {
    reserve: jest.fn(),
  } as unknown as jest.Mocked<SharedReservationPort>;
  const ledger = {
    beginPost: jest.fn(),
    recordReceipt: jest.fn(),
    markUnknown: jest.fn(),
  } as unknown as jest.Mocked<RestockPostLedgerPort>;
  const client = {
    submitRestockIntake: jest.fn(),
  } as unknown as jest.Mocked<Pick<ChatbotApiClient, 'submitRestockIntake'>>;
  return {
    service: new RestockIntakeService(reservations, ledger, client),
    reservations,
    ledger,
    client,
  };
};

describe('RestockIntakeService.coordinate', () => {
  it('posts once and records the durable receipt id', async () => {
    const { service, reservations, ledger, client } = build();
    const i = intake();
    reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    ledger.beginPost.mockResolvedValue({ action: 'authorize_post' });
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    ledger.recordReceipt.mockResolvedValue({
      action: 'record_receipt',
      backendDecisionId: DECISION,
    });

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'recorded', historicalPollId: DECISION });

    expect(reservations.reserve).toHaveBeenCalledWith({
      senderId: SENDER,
      route: 'RESTOCK',
      requestKey: SOURCE,
      intake: i,
    });
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
    expect(client.submitRestockIntake).toHaveBeenCalledWith(i);
    expect(ledger.recordReceipt).toHaveBeenCalledWith({
      senderId: SENDER,
      sourceRequestId: SOURCE,
      backendDecisionId: DECISION,
    });
    expect(ledger.markUnknown).not.toHaveBeenCalled();
  });

  it('returns an existing historical poll id without any POST', async () => {
    const { service, reservations, ledger, client } = build();
    reservations.reserve.mockResolvedValue({
      action: 'replay',
      reason: 'exact_active_replay',
    });
    ledger.beginPost.mockResolvedValue({
      action: 'historical_receipt',
      backendDecisionId: DECISION,
    });

    await expect(
      service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'existing', historicalPollId: DECISION });
    expect(client.submitRestockIntake).not.toHaveBeenCalled();
  });

  it('treats a same-id record replay as existing', async () => {
    const { service, reservations, ledger, client } = build();
    const i = intake();
    reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    ledger.beginPost.mockResolvedValue({ action: 'authorize_post' });
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    ledger.recordReceipt.mockResolvedValue({
      action: 'replay_receipt',
      backendDecisionId: DECISION,
    });

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'existing', historicalPollId: DECISION });
  });

  it('posts once for two concurrent identical calls', async () => {
    const { service, reservations, ledger, client } = build();
    const i = intake();
    reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    ledger.beginPost
      .mockResolvedValueOnce({ action: 'authorize_post' })
      .mockResolvedValueOnce({ action: 'hold', reason: 'post_in_flight' });
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    ledger.recordReceipt.mockResolvedValue({
      action: 'record_receipt',
      backendDecisionId: DECISION,
    });

    const [a, b] = await Promise.all([
      service.coordinate({ senderId: SENDER, intake: i }),
      service.coordinate({ senderId: SENDER, intake: i }),
    ]);
    expect(a).toEqual({ decision: 'recorded', historicalPollId: DECISION });
    expect(b).toEqual({ decision: 'hold', reason: 'post_in_flight' });
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
  });
});
