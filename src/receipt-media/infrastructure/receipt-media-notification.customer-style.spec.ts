/** S1: receipt notices in the stored customer style (usted when unknown). */
import type { CustomerStyle } from '../../llm-agent/domain/customer-style';
import type { ReceiptMediaOutboxRow } from '../domain/receipt-media.types';
import type {
  OutboundText,
  SendResult,
} from '../../whatsapp/domain/whatsapp-sender.port';
import {
  ReceiptMediaNotificationWorker,
  renderNotificationText,
} from './receipt-media-notification.worker';

const flush = () => new Promise<void>((r) => setImmediate(r));
const TU: CustomerStyle = { register: 'tu', emojis: false, tone: 'casual' };

const intent = (over: Partial<ReceiptMediaOutboxRow> = {}) =>
  ({
    id: 'i1',
    recipientId: '5215550001111',
    templateKey: 'RECEIPT_PAYMENT_PARTIAL',
    templateArgs: { folio: 'F-1', debtCents: 123456 },
    status: 'PENDING',
    attempts: 0,
    leaseExpiresAt: new Date(1_700_000_000_000),
    ...over,
  }) as unknown as ReceiptMediaOutboxRow;

const live = new Set<ReceiptMediaNotificationWorker>();
afterEach(async () => {
  for (const worker of live) await worker.onModuleDestroy();
  live.clear();
});

async function sentText(
  styleFor: (recipientId: string) => Promise<CustomerStyle | null>,
  row = intent(),
): Promise<{ text: string; styleFor: jest.Mock }> {
  const sendText = jest.fn<Promise<SendResult>, [OutboundText]>(() =>
    Promise.resolve({ providerMessageId: 'wamid.OK' }),
  );
  const spy = jest.fn(styleFor);
  const batches = [[row]];
  const worker = new ReceiptMediaNotificationWorker(
    {
      claimBatch: jest.fn(() => Promise.resolve(batches.shift() ?? [])),
      markSent: jest.fn(() => Promise.resolve(true)),
      reschedule: jest.fn(() => Promise.resolve('rescheduled' as const)),
    },
    { sendText },
    { onExhausted: jest.fn(() => Promise.resolve()) },
    { owner: 'wn', pollIntervalMs: 1_000, batchSize: 5, maxConcurrency: 2 },
    undefined,
    spy,
  );
  live.add(worker);
  worker.onApplicationBootstrap();
  for (let i = 0; i < 5 && sendText.mock.calls.length === 0; i++) await flush();
  return { text: sendText.mock.calls[0][0].text, styleFor: spy };
}

describe('receipt notices in the stored customer style (S1)', () => {
  it('a tú profile gets the tú copy, amounts and folio intact', async () => {
    const { text, styleFor } = await sentText(() => Promise.resolve(TU));
    expect(styleFor).toHaveBeenCalledWith('5215550001111');
    expect(text).toBe(
      'Confirmamos un pago de tu pedido F-1. Queda un saldo pendiente de $1,234.56 MXN; puedes enviarnos el comprobante del resto cuando lo tengas.',
    );
  });

  it('a missing profile keeps the usted copy byte-identical', async () => {
    const { text } = await sentText(() => Promise.resolve(null));
    expect(text).toBe(renderNotificationText(intent()));
  });

  it('a failed profile read still sends the usted copy', async () => {
    const { text } = await sentText(() => Promise.reject(new Error('down')));
    expect(text).toBe(renderNotificationText(intent()));
  });

  it('never rewrites the backend rejection reason', () => {
    const row = intent({
      templateKey: 'RECEIPT_PAYMENT_REJECTED',
      templateArgs: {
        folio: 'F-1',
        reason: 'el monto no coincide con su pedido',
      },
    });
    expect(renderNotificationText(row, TU)).toBe(
      'No pudimos confirmar tu comprobante del pedido F-1: el monto no coincide con su pedido. ¿Me puedes enviar otro comprobante?',
    );
    expect(renderNotificationText(row, null)).toBe(renderNotificationText(row));
  });
});
