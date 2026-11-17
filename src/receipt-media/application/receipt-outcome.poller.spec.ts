import { Logger } from '@nestjs/common';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import type { CustomerInboundObservationLatest } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import type { ReceiptOutcome } from '../../chatbot-api/domain/dtos/receipt-outcome.dto';
import type {
  ReceiptOutcomeCandidate,
  ReceiptOutcomeStore,
} from '../domain/receipt-outcome';
import {
  ReceiptOutcomePoller,
  type ReceiptOutcomePollerPorts,
} from './receipt-outcome.poller';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const PHONE = '1234567890';
const candidate = (
  over: Partial<ReceiptOutcomeCandidate> = {},
): ReceiptOutcomeCandidate => ({
  id: '11111111-1111-4111-8111-111111111111',
  senderId: '5215512345678',
  backendReceiptId: '33333333-3333-4333-8333-333333333333',
  saleFolio: 'F-12',
  capturedSaleId: '44444444-4444-4444-8444-444444444444',
  attachedAt: new Date('2026-11-05T10:00:00.000Z'),
  outcomePolledAt: null,
  ...over,
});
const outcome = (over: Partial<ReceiptOutcome> = {}): ReceiptOutcome => ({
  status: 'CONFIRMED',
  customerReason: null,
  sale: { debtCents: 0, paymentStatus: 'PAID' },
  ...over,
});
/** Inbound observation `secondsAgo` before NOW. */
const inbound = (secondsAgo: number) => ({
  kind: 'found' as const,
  observation: {
    providerTimestampSeconds: String(NOW.getTime() / 1000 - secondsAgo),
  },
});

describe('ReceiptOutcomePoller', () => {
  let store: jest.Mocked<ReceiptOutcomeStore>;
  let ports: jest.Mocked<ReceiptOutcomePollerPorts>;
  let poller: ReceiptOutcomePoller;

  beforeEach(() => {
    store = {
      listOutcomeDue: jest.fn().mockResolvedValue([]),
      markOutcomePolled: jest.fn().mockResolvedValue(undefined),
      commitOutcome: jest
        .fn()
        .mockResolvedValue({ kind: 'committed', intent: null }),
    };
    ports = {
      getReceiptOutcome: jest.fn().mockResolvedValue(outcome()),
      readLatest: jest.fn().mockResolvedValue(inbound(60)),
    };
    poller = new ReceiptOutcomePoller(
      store,
      ports,
      PHONE,
      { intervalMs: 1000, batchSize: 5 },
      () => NOW,
    );
  });

  it('only stamps the poll while the receipt is PENDING', async () => {
    ports.getReceiptOutcome.mockResolvedValue(outcome({ status: 'PENDING' }));
    await poller.process(candidate());
    expect(ports.getReceiptOutcome).toHaveBeenCalledWith(
      '33333333-3333-4333-8333-333333333333',
    );
    expect(store.markOutcomePolled).toHaveBeenCalledWith(candidate().id);
    expect(store.commitOutcome).not.toHaveBeenCalled();
  });

  it('stamps the poll and keeps polling when the backend read fails', async () => {
    ports.getReceiptOutcome.mockRejectedValue(
      new ChatbotApiError('down', 503, undefined, null),
    );
    await poller.process(candidate());
    expect(store.markOutcomePolled).toHaveBeenCalledWith(candidate().id);
    expect(store.commitOutcome).not.toHaveBeenCalled();
  });

  it('queues the fully-paid confirmation inside the 24 h window', async () => {
    await poller.process(candidate());
    expect(ports.readLatest).toHaveBeenCalledWith('5215512345678', PHONE);
    expect(store.commitOutcome).toHaveBeenCalledWith({
      id: candidate().id,
      status: 'CONFIRMED',
      customerReason: null,
      debtCents: 0,
      delivery: 'QUEUED',
      templateKey: 'RECEIPT_PAYMENT_CONFIRMED',
      templateArgs: { folio: 'F-12' },
    });
    expect(store.markOutcomePolled).not.toHaveBeenCalled();
  });

  it('queues the partial confirmation with the remaining debt', async () => {
    ports.getReceiptOutcome.mockResolvedValue(
      outcome({ sale: { debtCents: 150000, paymentStatus: 'PARTIAL' } }),
    );
    await poller.process(candidate({ saleFolio: null }));
    expect(store.commitOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        debtCents: 150000,
        templateKey: 'RECEIPT_PAYMENT_PARTIAL',
        templateArgs: { debtCents: 150000 },
      }),
    );
  });

  it('queues the rejection with the customer reason', async () => {
    ports.getReceiptOutcome.mockResolvedValue(
      outcome({
        status: 'REJECTED',
        customerReason: 'El monto no coincide',
        sale: { debtCents: 50000, paymentStatus: 'CREDIT' },
      }),
    );
    await poller.process(candidate());
    expect(store.commitOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'REJECTED',
        customerReason: 'El monto no coincide',
        debtCents: 50000,
        templateKey: 'RECEIPT_PAYMENT_REJECTED',
        templateArgs: { folio: 'F-12', reason: 'El monto no coincide' },
      }),
    );
  });

  it.each([
    ['the last message is older than 24 h', inbound(86_400)],
    ['no inbound message is known', { kind: 'missing' as const }],
    ['the inbound row is unreadable', { kind: 'hold' as const }],
  ])(
    'records OUTSIDE_WINDOW without a message when %s',
    async (_label, latest) => {
      ports.readLatest.mockResolvedValue(
        latest as unknown as CustomerInboundObservationLatest,
      );
      await poller.process(candidate());
      expect(store.commitOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ delivery: 'OUTSIDE_WINDOW' }),
      );
    },
  );

  it('treats a failed window read as outside the window', async () => {
    ports.readLatest.mockRejectedValue(new Error('db'));
    await poller.process(candidate());
    expect(store.commitOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: 'OUTSIDE_WINDOW' }),
    );
  });

  it('ticks a bounded due batch and survives a failing row', async () => {
    const a = candidate({ id: 'a' });
    const b = candidate({ id: 'b' });
    store.listOutcomeDue.mockResolvedValue([a, b]);
    ports.getReceiptOutcome.mockResolvedValue(outcome({ status: 'PENDING' }));
    store.markOutcomePolled
      .mockRejectedValueOnce(new Error('db'))
      .mockResolvedValue(undefined);
    await poller.tick();
    expect(store.listOutcomeDue).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ intervalMs: 1000 }),
    );
    expect(store.markOutcomePolled).toHaveBeenCalledTimes(2);
  });

  it('survives a failing due read', async () => {
    store.listOutcomeDue.mockRejectedValue(new Error('db'));
    await expect(poller.tick()).resolves.toBeUndefined();
  });

  it('runs on boot, then every interval, and stops cleanly', async () => {
    jest.useFakeTimers();
    try {
      poller.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(store.listOutcomeDue).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1000);
      expect(store.listOutcomeDue).toHaveBeenCalledTimes(2);
      await poller.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(store.listOutcomeDue).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects non-positive bounds', () => {
    expect(
      () => new ReceiptOutcomePoller(store, ports, PHONE, { batchSize: 0 }),
    ).toThrow(RangeError);
  });

  describe('paid sale in the conversation (S6)', () => {
    let markSalePaid: jest.Mock<Promise<unknown>, [string, string]>;
    beforeEach(() => {
      markSalePaid = jest
        .fn<Promise<unknown>, [string, string]>()
        .mockResolvedValue(true);
      poller = new ReceiptOutcomePoller(
        store,
        { ...ports, markSalePaid },
        PHONE,
        { intervalMs: 1000, batchSize: 5 },
        () => NOW,
      );
    });

    it('marks the placed sale paid after committing a CONFIRMED outcome with no debt', async () => {
      await poller.process(candidate());
      expect(markSalePaid).toHaveBeenCalledWith(
        '5215512345678',
        '44444444-4444-4444-8444-444444444444',
      );
      expect(store.commitOutcome.mock.invocationCallOrder[0]).toBeLessThan(
        markSalePaid.mock.invocationCallOrder[0],
      );
    });

    it('marks it paid also when the 24 h window is closed (the fact is the same)', async () => {
      ports.readLatest.mockResolvedValue(
        inbound(86_400) as unknown as CustomerInboundObservationLatest,
      );
      await poller.process(candidate());
      expect(store.commitOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ delivery: 'OUTSIDE_WINDOW' }),
      );
      expect(markSalePaid).toHaveBeenCalledTimes(1);
    });

    it('keeps the order unpaid for a PARTIAL confirmation', async () => {
      ports.getReceiptOutcome.mockResolvedValue(
        outcome({ sale: { debtCents: 150000, paymentStatus: 'PARTIAL' } }),
      );
      await poller.process(candidate());
      expect(store.commitOutcome).toHaveBeenCalledTimes(1);
      expect(markSalePaid).not.toHaveBeenCalled();
    });

    it.each([
      ['REJECTED', outcome({ status: 'REJECTED', customerReason: 'No' })],
      ['PENDING', outcome({ status: 'PENDING' })],
    ])('never marks it paid for %s', async (_label, result) => {
      ports.getReceiptOutcome.mockResolvedValue(result);
      await poller.process(candidate());
      expect(markSalePaid).not.toHaveBeenCalled();
    });

    it('does not mark it when another worker already recorded the outcome', async () => {
      store.commitOutcome.mockResolvedValue({ kind: 'already-notified' });
      await poller.process(candidate());
      expect(markSalePaid).not.toHaveBeenCalled();
    });

    it.each([
      ['rejects', () => Promise.reject(new Error('cas'))],
      [
        'throws synchronously',
        () => {
          throw new Error('cas');
        },
      ],
    ])(
      'never blocks or fails the notice when the mark %s',
      async (_l, fail) => {
        markSalePaid.mockImplementation(fail);
        await expect(poller.process(candidate())).resolves.toBeUndefined();
        expect(store.commitOutcome).toHaveBeenCalledTimes(1);
      },
    );

    describe('a mark that resolves false (lost race, unreadable state)', () => {
      let warn: jest.SpyInstance<void, [message: unknown]>;
      beforeEach(() => {
        warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined) as unknown as typeof warn;
      });
      afterEach(() => warn.mockRestore());
      const flush = () => new Promise((resolve) => setImmediate(resolve));

      it('logs a warn with the receipt id and no sender data', async () => {
        markSalePaid.mockResolvedValue(false);
        await poller.process(candidate());
        await flush();
        const lines = warn.mock.calls.map((args) => String(args[0]));
        const line = lines.find((text) => text.includes('paid mark'));
        expect(line).toBeDefined();
        expect(line).toContain(candidate().id);
        expect(line).not.toContain('5215512345678');
        expect(line).not.toContain(candidate().capturedSaleId);
      });

      it('stays silent when the mark succeeds', async () => {
        markSalePaid.mockResolvedValue(true);
        await poller.process(candidate());
        await flush();
        expect(
          warn.mock.calls.some((args) => String(args[0]).includes('paid mark')),
        ).toBe(false);
      });
    });

    it('does not wait for a slow mark', async () => {
      markSalePaid.mockReturnValue(new Promise(() => undefined));
      await expect(poller.process(candidate())).resolves.toBeUndefined();
    });

    it('works without the optional port', async () => {
      poller = new ReceiptOutcomePoller(store, ports, PHONE, {}, () => NOW);
      await expect(poller.process(candidate())).resolves.toBeUndefined();
    });
  });
});
