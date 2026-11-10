/** S7 send hold: while the conversation is HUMAN (or the mode is unreadable)
 * a claimed receipt notice is neither sent nor bookkept, so the SENDING
 * lease expires and the row is claimed again with `attempts` unchanged. */
import type { ReceiptMediaOutboxRow } from '../domain/receipt-media.types';
import type {
  OutboundText,
  SendResult,
} from '../../whatsapp/domain/whatsapp-sender.port';
import type { HandoffModeReader } from '../../conversation/application/handoff-send-hold';
import { ReceiptMediaNotificationWorker } from './receipt-media-notification.worker';

const flush = () => new Promise<void>((r) => setImmediate(r));

const LEASE = new Date(1_700_000_000_000);

const intent = (over: Partial<ReceiptMediaOutboxRow> = {}) =>
  ({
    id: 'i1',
    recipientId: '+525500000000',
    templateKey: 'RECEIPT_PAYMENT_PARTIAL',
    templateArgs: { folio: 'F-1', debtCents: 123456 },
    status: 'PENDING',
    attempts: 0,
    leaseExpiresAt: LEASE,
    ...over,
  }) as unknown as ReceiptMediaOutboxRow;

const live = new Set<ReceiptMediaNotificationWorker>();

const harness = (
  isHumanMode: HandoffModeReader['isHumanMode'],
  batches: ReceiptMediaOutboxRow[][],
) => {
  const claimBatch = jest.fn(() => Promise.resolve(batches.shift() ?? []));
  const markSent = jest.fn(() => Promise.resolve(true));
  const reschedule = jest.fn(() => Promise.resolve('rescheduled' as const));
  const onExhausted = jest.fn(() => Promise.resolve());
  const sendText = jest.fn<Promise<SendResult>, [OutboundText]>(() =>
    Promise.resolve({ providerMessageId: 'wamid.OK' }),
  );
  const isOpen = jest.fn(() => Promise.resolve(true));
  const markNotDelivered = jest.fn(() => Promise.resolve(true));
  const customerStyle = jest.fn(() => Promise.resolve(null));
  const reader = { isHumanMode: jest.fn(isHumanMode) };
  const worker = new ReceiptMediaNotificationWorker(
    { claimBatch, markSent, reschedule },
    { sendText },
    { onExhausted },
    { owner: 'wn', pollIntervalMs: 1_000, batchSize: 5, maxConcurrency: 2 },
    { isOpen, markNotDelivered },
    customerStyle,
    reader,
  );
  live.add(worker);
  return {
    worker,
    claimBatch,
    markSent,
    reschedule,
    onExhausted,
    sendText,
    isOpen,
    markNotDelivered,
    customerStyle,
    reader,
  };
};

afterEach(async () => {
  for (const worker of live) await worker.onModuleDestroy();
  live.clear();
});

describe('ReceiptMediaNotificationWorker S7 handoff hold', () => {
  it.each([
    ['HUMAN', () => Promise.resolve(true)],
    ['an unreadable mode', () => Promise.reject(new Error('db down'))],
  ])(
    '%s: no send and no bookkeeping, so the lease expires and the row is reclaimed',
    async (_label, isHumanMode) => {
      const h = harness(isHumanMode, [[intent()]]);
      h.worker.onApplicationBootstrap();
      await flush();
      await flush();
      expect(h.reader.isHumanMode).toHaveBeenCalledWith('+525500000000');
      expect(h.sendText).not.toHaveBeenCalled();
      expect(h.markSent).not.toHaveBeenCalled();
      expect(h.reschedule).not.toHaveBeenCalled();
      expect(h.onExhausted).not.toHaveBeenCalled();
      // The hold comes before the outcome-window gate and the style read.
      expect(h.isOpen).not.toHaveBeenCalled();
      expect(h.markNotDelivered).not.toHaveBeenCalled();
      expect(h.customerStyle).not.toHaveBeenCalled();
    },
  );

  it('BOT: sends and marks as before', async () => {
    const h = harness(() => Promise.resolve(false), [[intent()]]);
    h.worker.onApplicationBootstrap();
    await flush();
    await flush();
    expect(h.reader.isHumanMode).toHaveBeenCalledWith('+525500000000');
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.markSent).toHaveBeenCalledWith('i1', 'wn', 'wamid.OK', LEASE);
    expect(h.reschedule).not.toHaveBeenCalled();
  });

  it('a held row reclaimed after the session ended is sent with attempts unchanged', async () => {
    let human = true;
    const h = harness(() => Promise.resolve(human), [[intent()]]);
    h.worker.onApplicationBootstrap();
    await flush();
    await flush();
    expect(h.sendText).not.toHaveBeenCalled();
    // The SENDING lease expired; the claim returns the same row untouched.
    human = false;
    const reclaimed = intent({ status: 'SENDING', attempts: 0 });
    h.claimBatch.mockResolvedValueOnce([reclaimed]);
    h.worker.wake();
    await flush();
    await flush();
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.markSent).toHaveBeenCalledTimes(1);
    expect(h.reschedule).not.toHaveBeenCalled();
  });
});
