import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  RestockIntakeInput,
  RestockIntakeReceipt,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type { RestockPostLedgerPort } from '../domain/restock-post-ledger';
import type { SharedReservationPort } from '../domain/shared-reservation';
import { RestockIntakeService } from './restock-intake.service';

/**
 * R3b3-c4 adversarial spec for the inert RESTOCK intake coordinator: failure
 * ordering, conservative holds, ambiguous-record readback and no-retry. Real
 * fake ports only; no external call. Nothing here claims durable UNKNOWN or
 * current decision state.
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
const authorizeOnce = (ledger: jest.Mocked<RestockPostLedgerPort>) =>
  ledger.beginPost
    .mockResolvedValueOnce({ action: 'authorize_post' })
    .mockResolvedValueOnce({
      action: 'historical_receipt',
      backendDecisionId: DECISION,
    });

describe('RestockIntakeService.coordinate adversarial', () => {
  it('holds and marks UNKNOWN after a failed POST without retrying', async () => {
    const { service, reservations, ledger, client } = build();
    const i = intake();
    reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    ledger.beginPost.mockResolvedValue({ action: 'authorize_post' });
    client.submitRestockIntake.mockRejectedValue(new Error('timeout'));
    ledger.markUnknown.mockResolvedValue({
      action: 'hold',
      reason: 'unknown_state',
    });

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
    expect(ledger.recordReceipt).not.toHaveBeenCalled();
    expect(ledger.markUnknown).toHaveBeenCalledWith({
      senderId: SENDER,
      sourceRequestId: SOURCE,
    });
  });

  it('holds on a failed markUnknown without claiming durable UNKNOWN', async () => {
    const { service, reservations, ledger, client } = build();
    reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    ledger.beginPost.mockResolvedValue({ action: 'authorize_post' });
    client.submitRestockIntake.mockRejectedValue(new Error('timeout'));
    ledger.markUnknown.mockRejectedValue(new Error('db down'));

    await expect(
      service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
  });

  it('holds on a malformed or mismatched receipt', async () => {
    const malformed = build();
    malformed.reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    malformed.ledger.beginPost.mockResolvedValue({ action: 'authorize_post' });
    malformed.client.submitRestockIntake.mockResolvedValue({
      ...receiptFor(intake()),
      status: 'RESOLVED',
    } as unknown as RestockIntakeReceipt);
    malformed.ledger.markUnknown.mockResolvedValue({
      action: 'authorize_post',
    });
    await expect(
      malformed.service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect(malformed.ledger.recordReceipt).not.toHaveBeenCalled();

    const mismatched = build();
    const sent = intake({ productName: 'Otro producto' });
    mismatched.reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    mismatched.ledger.beginPost.mockResolvedValue({ action: 'authorize_post' });
    mismatched.client.submitRestockIntake.mockResolvedValue(
      receiptFor(intake()),
    );
    mismatched.ledger.markUnknown.mockResolvedValue({
      action: 'authorize_post',
    });
    await expect(
      mismatched.service.coordinate({ senderId: SENDER, intake: sent }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
  });

  it('recovers the same historical id when a record is ambiguous but readback confirms', async () => {
    const { service, reservations, ledger, client } = build();
    const i = intake();
    reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    ledger.recordReceipt.mockRejectedValue(new Error('ambiguous commit'));
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    authorizeOnce(ledger);
    ledger.markUnknown.mockResolvedValue({
      action: 'mark_unknown',
      reason: 'ambiguous_post',
    });

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'existing', historicalPollId: DECISION });
  });

  it('holds unconfirmed when an ambiguous record readback does not confirm', async () => {
    const { service, reservations, ledger, client } = build();
    const i = intake();
    reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    ledger.recordReceipt.mockResolvedValue({
      action: 'conflict',
      storedBackendDecisionId: DECISION,
    });
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    ledger.beginPost
      .mockResolvedValueOnce({ action: 'authorize_post' })
      .mockResolvedValueOnce({ action: 'hold', reason: 'post_in_flight' });
    ledger.markUnknown.mockResolvedValue({
      action: 'mark_unknown',
      reason: 'ambiguous_post',
    });

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'hold', reason: 'record_unconfirmed' });
  });

  it('blocks malformed input and collisions before acting', async () => {
    const malformed = build();
    await expect(
      malformed.service.coordinate({
        senderId: SENDER,
        intake: { type: 'RESTOCK' },
      }),
    ).resolves.toEqual({ decision: 'blocked', reason: 'malformed_input' });
    expect(malformed.reservations.reserve).not.toHaveBeenCalled();
    expect(malformed.client.submitRestockIntake).not.toHaveBeenCalled();

    const collision = build();
    collision.reservations.reserve.mockResolvedValue({
      action: 'conflict',
      reason: 'same_key_different_payload',
    });
    await expect(
      collision.service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'blocked', reason: 'collision' });
    expect(collision.client.submitRestockIntake).not.toHaveBeenCalled();
  });

  it('blocks an occupied reservation without a POST', async () => {
    const { service, reservations, ledger, client } = build();
    reservations.reserve.mockResolvedValue({
      action: 'occupied',
      reason: 'different_active_key',
      activeRoute: 'LEGACY_OPS',
    });

    await expect(
      service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'blocked', reason: 'occupied' });
    expect(ledger.beginPost).not.toHaveBeenCalled();
    expect(client.submitRestockIntake).not.toHaveBeenCalled();
  });

  it('holds without a POST on a reserve or beginPost error', async () => {
    const reserveError = build();
    reserveError.reservations.reserve.mockRejectedValue(new Error('db down'));
    await expect(
      reserveError.service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect(reserveError.client.submitRestockIntake).not.toHaveBeenCalled();

    const beginError = build();
    beginError.reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    beginError.ledger.beginPost.mockRejectedValue(new Error('db down'));
    beginError.ledger.markUnknown.mockRejectedValue(new Error('db down'));
    await expect(
      beginError.service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect(beginError.client.submitRestockIntake).not.toHaveBeenCalled();
  });
});
