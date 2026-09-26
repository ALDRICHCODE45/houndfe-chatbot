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

const build = (
  onReceiptRecorded?: (sender: string, source: string) => void,
) => {
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
    service: new RestockIntakeService(
      reservations,
      ledger,
      client,
      onReceiptRecorded,
    ),
    reservations,
    ledger,
    client,
  };
};

describe('receipt-recorded enqueue seam', () => {
  const ready = (hook: (sender: string, source: string) => void) => {
    const f = build(hook);
    f.reservations.reserve.mockResolvedValue({
      action: 'claim',
      reason: 'single_sender_vacant',
    });
    f.ledger.beginPost.mockResolvedValue({ action: 'authorize_post' });
    f.client.submitRestockIntake.mockResolvedValue(receiptFor(intake()));
    f.ledger.recordReceipt.mockResolvedValue({
      action: 'record_receipt',
      backendDecisionId: DECISION,
    });
    return f;
  };

  it('enqueues captured primitives once only after durable confirmation', async () => {
    const hook = jest.fn();
    const f = ready(hook);
    let releaseReserve!: () => void;
    f.reservations.reserve.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseReserve = resolve;
      });
      return { action: 'claim', reason: 'single_sender_vacant' };
    });
    let confirm!: () => void;
    let entered!: () => void;
    const recording = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.ledger.recordReceipt.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        confirm = resolve;
      });
      return { action: 'record_receipt', backendDecisionId: DECISION };
    });
    const request = { senderId: SENDER, intake: intake() };
    const result = f.service.coordinate(request);
    request.senderId = 'replacement';
    request.intake.sourceRequestId = PRODUCT;
    expect(hook).not.toHaveBeenCalled();
    releaseReserve();
    await recording;
    expect(hook).not.toHaveBeenCalled();
    confirm();
    await expect(result).resolves.toEqual({
      decision: 'recorded',
      historicalPollId: DECISION,
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(SENDER, SOURCE);
  });

  it('keeps truthful recorded outcome when synchronous enqueue throws', async () => {
    const hook = jest.fn(() => {
      throw new Error('enqueue failed');
    });
    const f = ready(hook);
    await expect(
      f.service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'recorded', historicalPollId: DECISION });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(f.ledger.markUnknown).not.toHaveBeenCalled();
    expect(f.ledger.beginPost).toHaveBeenCalledTimes(1);
    expect(f.ledger.recordReceipt).toHaveBeenCalledTimes(1);
    expect(f.client.submitRestockIntake).toHaveBeenCalledTimes(1);
  });

  it.each([
    'historical',
    'replay',
    'ambiguous',
    'wrong-id',
    'failed-post',
    'bad-receipt',
    'hold',
    'blocked',
    'record-hold',
  ])('never enqueues %s outcomes', async (kind) => {
    const hook = jest.fn();
    const f = ready(hook);
    let expected: unknown = { decision: 'hold', reason: 'unknown_hold' };
    if (kind === 'historical' || kind === 'ambiguous') {
      expected = { decision: 'existing', historicalPollId: DECISION };
      f.ledger.beginPost.mockResolvedValue({
        action: 'historical_receipt',
        backendDecisionId: DECISION,
      });
      if (kind === 'ambiguous') {
        f.ledger.beginPost.mockResolvedValueOnce({ action: 'authorize_post' });
        f.ledger.recordReceipt.mockRejectedValue(new Error('ambiguous'));
      }
    }
    if (kind === 'replay') {
      expected = { decision: 'existing', historicalPollId: DECISION };
      f.ledger.recordReceipt.mockResolvedValue({
        action: 'replay_receipt',
        backendDecisionId: DECISION,
      });
    }
    if (kind === 'wrong-id' || kind === 'record-hold') {
      expected = { decision: 'hold', reason: 'record_unconfirmed' };
      f.ledger.recordReceipt.mockResolvedValue(
        kind === 'wrong-id'
          ? { action: 'record_receipt', backendDecisionId: PRODUCT }
          : { action: 'hold', reason: 'post_in_flight' },
      );
    }
    if (kind === 'failed-post')
      f.client.submitRestockIntake.mockRejectedValue(new Error('POST'));
    if (kind === 'bad-receipt')
      f.client.submitRestockIntake.mockResolvedValue(
        {} as RestockIntakeReceipt,
      );
    if (kind === 'hold') {
      expected = { decision: 'hold', reason: 'post_in_flight' };
      f.ledger.beginPost.mockResolvedValue({
        action: 'hold',
        reason: 'post_in_flight',
      });
    }
    if (kind === 'blocked') {
      expected = { decision: 'blocked', reason: 'reservation_blocked' };
      f.ledger.beginPost.mockResolvedValue({
        action: 'blocked',
        reason: 'missing_row',
      });
    }
    await expect(
      f.service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual(expected);
    expect(hook).not.toHaveBeenCalled();
  });
});

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
