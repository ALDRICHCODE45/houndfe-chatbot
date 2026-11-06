/** WU9 worker behavior: committed-row-only drain, deterministic payloads,
 * attempts 1-3 requeue/exhaustion, send-before-mark wamid ordering, CAS-loser
 * silence, byte-identical replay, drain shutdown, and no LLM authority. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReceiptMediaOutboxRow } from '../domain/receipt-media.types';
import { RECEIPT_TEMPLATE_KEYS } from '../domain/receipt-media.types';
import type {
  OutboundText,
  SendResult,
} from '../../whatsapp/domain/whatsapp-sender.port';
import {
  RETRY_DELAY_MS,
  ReceiptMediaNotificationWorker,
  renderNotificationText,
} from './receipt-media-notification.worker';

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

const harness = (batches: ReceiptMediaOutboxRow[][] = []) => {
  const claimBatch = jest.fn(() => Promise.resolve(batches.shift() ?? []));
  const markSent = jest.fn<Promise<boolean>, [string, string, string]>(() =>
    Promise.resolve(true),
  );
  const reschedule = jest.fn<
    Promise<'rescheduled' | 'exhausted' | 'lost'>,
    [string, string, number]
  >(() => Promise.resolve('rescheduled'));
  const onExhausted = jest.fn(() => Promise.resolve());
  const sendText = jest.fn<Promise<SendResult>, [OutboundText]>(() =>
    Promise.resolve({ providerMessageId: 'wamid.OK' }),
  );
  const worker = new ReceiptMediaNotificationWorker(
    { claimBatch, markSent, reschedule },
    { sendText },
    { onExhausted },
    { owner: 'wn', pollIntervalMs: 1_000, batchSize: 5, maxConcurrency: 2 },
  );
  live.add(worker);
  return { worker, claimBatch, markSent, reschedule, onExhausted, sendText };
};

afterEach(async () => {
  for (const worker of live) await worker.onModuleDestroy();
  live.clear();
});

describe('ReceiptMediaNotificationWorker (WU9)', () => {
  it('rejects unsafe options synchronously', () => {
    expect(() => harness()).not.toThrow();
    expect(
      () =>
        new ReceiptMediaNotificationWorker(
          { claimBatch: jest.fn(), markSent: jest.fn(), reschedule: jest.fn() },
          { sendText: jest.fn() },
          { onExhausted: jest.fn() },
          { owner: '', pollIntervalMs: 1_000, batchSize: 5, maxConcurrency: 2 },
        ),
    ).toThrow('invalid worker options');
  });

  it('drains only claimed committed intents: exact deterministic payload', async () => {
    const h = harness([[intent()]]);
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.claimBatch).toHaveBeenCalledWith(2, 'wn'); // min(capacity, batch)
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText).toHaveBeenCalledWith({
      to: '+525500000000',
      text: 'Confirmamos un pago de su pedido F-1. Queda un saldo pendiente de $1,234.56 MXN; puede enviarnos el comprobante del resto cuando lo tenga.',
    });
  });

  it('has no proactive path: no claimed rows, no sends or mutations', async () => {
    const h = harness();
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(h.reschedule).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
  });

  it('marks SENT with the provider wamid only after the send resolves', async () => {
    const order: string[] = [];
    const h = harness([[intent()]]);
    h.sendText.mockImplementation(() => {
      order.push('send');
      return Promise.resolve({ providerMessageId: 'wamid.XYZ' });
    });
    h.markSent.mockImplementation(() => {
      order.push('mark');
      return Promise.resolve(true);
    });
    h.worker.onApplicationBootstrap();
    await flush();
    expect(order).toEqual(['send', 'mark']);
    expect(h.markSent).toHaveBeenCalledWith('i1', 'wn', 'wamid.XYZ', LEASE);
  });

  it('requeues attempts 1-2 and exhausts with exactly one alert on the third', async () => {
    const row = intent({
      id: 'i2',
      templateKey: 'RECEIPT_ATTACH_UNKNOWN',
      templateArgs: {},
    });
    const h = harness([[row], [row], [row]]);
    h.sendText.mockRejectedValue(new Error('meta transport down'));
    h.reschedule
      .mockResolvedValueOnce('rescheduled')
      .mockResolvedValueOnce('rescheduled')
      .mockResolvedValue('exhausted');
    h.worker.onApplicationBootstrap();
    await flush();
    await flush();
    expect(h.sendText).toHaveBeenCalledTimes(3);
    expect(h.reschedule.mock.calls).toEqual([
      ['i2', 'wn', RETRY_DELAY_MS, LEASE],
      ['i2', 'wn', RETRY_DELAY_MS, LEASE],
      ['i2', 'wn', RETRY_DELAY_MS, LEASE],
    ]);
    expect(h.markSent).not.toHaveBeenCalled();
    expect(h.onExhausted).toHaveBeenCalledTimes(1);
    expect(h.onExhausted).toHaveBeenCalledWith(row);
  });

  it('treats a lost reschedule fence silently with no alert', async () => {
    const h = harness([[intent({ id: 'i3' })]]);
    h.sendText.mockRejectedValue(new Error('meta transport down'));
    h.reschedule.mockResolvedValue('lost');
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.reschedule).toHaveBeenCalledWith(
      'i3',
      'wn',
      RETRY_DELAY_MS,
      LEASE,
    );
    expect(h.markSent).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
  });

  it('CAS loser mutates nothing further; replay after lease expiry is byte-identical', async () => {
    const row = intent({
      status: 'SENDING',
      leaseOwner: 'old-worker',
      leaseExpiresAt: new Date(0),
    });
    const crashed = harness([[row]]);
    crashed.markSent.mockResolvedValue(false); // send succeeded, mark lost
    crashed.worker.onApplicationBootstrap();
    await flush();
    expect(crashed.sendText).toHaveBeenCalledTimes(1);
    expect(crashed.markSent).toHaveBeenCalledWith(
      'i1',
      'wn',
      'wamid.OK',
      new Date(0),
    );
    expect(crashed.reschedule).not.toHaveBeenCalled();
    expect(crashed.onExhausted).not.toHaveBeenCalled();
    await crashed.worker.onModuleDestroy();
    const reclaimed = harness([[row]]);
    reclaimed.worker.onApplicationBootstrap();
    await flush();
    expect(reclaimed.sendText.mock.calls[0]?.[0]).toEqual(
      crashed.sendText.mock.calls[0]?.[0],
    );
  });

  it('renders every tracked template key deterministically, no free-form path', () => {
    const argsFor = (
      key: ReceiptMediaOutboxRow['templateKey'],
    ): Record<string, number | string> =>
      key === 'RECEIPT_ATTACHED_PENDING'
        ? { folio: 'F-1' }
        : key === 'RECEIPT_PAYMENT_PARTIAL'
          ? { folio: 'F-1', debtCents: 150000 }
          : {};
    for (const key of RECEIPT_TEMPLATE_KEYS) {
      const row = intent({ templateKey: key, templateArgs: argsFor(key) });
      const text = renderNotificationText(row);
      expect(text).toBe(renderNotificationText(row)); // deterministic
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('{'); // no unresolved placeholder
      expect(text).toBe(text.trim());
    }
    expect(renderNotificationText(intent())).toBe(
      'Confirmamos un pago de su pedido F-1. Queda un saldo pendiente de $1,234.56 MXN; puede enviarnos el comprobante del resto cuando lo tenga.',
    );
  });

  describe('R2/S9 receipt outcome messages', () => {
    const render = (
      templateKey: ReceiptMediaOutboxRow['templateKey'],
      templateArgs: Record<string, number | string> = {},
    ) => renderNotificationText({ templateKey, templateArgs });

    it('says received and in review with the folio, without any amount prompt', () => {
      expect(render('RECEIPT_ATTACHED_PENDING', { folio: 'F-0042' })).toBe(
        'Recibimos su comprobante del pedido F-0042. Lo estamos revisando y le avisamos en cuanto se confirme.',
      );
      expect(render('RECEIPT_ATTACHED_PENDING')).toBe(
        'Recibimos su comprobante. Lo estamos revisando y le avisamos en cuanto se confirme.',
      );
    });

    it('adds one sentence when the extracted amount differs from the order total', () => {
      expect(
        render('RECEIPT_ATTACHED_PENDING', {
          folio: 'F-0042',
          extractedAmountCents: 140050,
          totalCents: 150000,
        }),
      ).toBe(
        'Recibimos su comprobante del pedido F-0042. Lo estamos revisando y le avisamos en cuanto se confirme. Vemos un monto de $1,400.50 MXN y su pedido es de $1,500.00 MXN; lo revisamos igual.',
      );
    });

    it.each([
      [
        'RECEIPT_SALE_ALREADY_PAID',
        { folio: 'F-0042' },
        'Su pedido F-0042 ya está pagado.',
      ],
      ['RECEIPT_SALE_ALREADY_PAID', {}, 'Su pedido ya está pagado.'],
      [
        'RECEIPT_SALE_NOT_PAYABLE',
        {},
        'Ese pedido ya no admite pagos; si cree que es un error, escríbanos.',
      ],
      [
        'RECEIPT_UNSUPPORTED_FORMAT',
        {},
        'Envíenos su comprobante como imagen JPEG o PNG, o como PDF, de menos de 10 MB.',
      ],
      [
        'RECEIPT_ATTACH_UNKNOWN',
        {},
        'Estamos registrando su comprobante; le avisamos en cuanto quede.',
      ],
      [
        'RECEIPT_NOT_A_RECEIPT',
        {},
        'Esta imagen no parece un comprobante de pago. Si quería enviarnos su comprobante, mándelo de nuevo; si no, dígame en qué le ayudo.',
      ],
      [
        'RECEIPT_NOT_A_RECEIPT',
        { mediaKind: 'pdf' },
        'Este archivo no parece un comprobante de pago. Si quería enviarnos su comprobante, mándelo de nuevo; si no, dígame en qué le ayudo.',
      ],
      [
        'RECEIPT_PDF_ENCRYPTED',
        {},
        'Su PDF está protegido con contraseña y no podemos abrirlo. ¿Nos envía una captura de pantalla del comprobante?',
      ],
    ] as const)('renders %s %j', (key, args, text) => {
      expect(render(key, args)).toBe(text);
    });
  });

  describe('R5/S5 human outcome messages', () => {
    const render = (
      templateKey: ReceiptMediaOutboxRow['templateKey'],
      templateArgs: Record<string, number | string> = {},
    ) => renderNotificationText({ templateKey, templateArgs });

    it.each([
      [
        'RECEIPT_PAYMENT_CONFIRMED',
        { folio: 'F-0042' },
        '¡Listo! Confirmamos su pago del pedido F-0042. Gracias por su compra.',
      ],
      [
        'RECEIPT_PAYMENT_CONFIRMED',
        {},
        '¡Listo! Confirmamos su pago de su pedido. Gracias por su compra.',
      ],
      [
        'RECEIPT_PAYMENT_PARTIAL',
        { folio: 'F-0042', debtCents: 150000 },
        'Confirmamos un pago de su pedido F-0042. Queda un saldo pendiente de $1,500.00 MXN; puede enviarnos el comprobante del resto cuando lo tenga.',
      ],
      [
        'RECEIPT_PAYMENT_PARTIAL',
        { debtCents: 5 },
        'Confirmamos un pago de su pedido. Queda un saldo pendiente de $0.05 MXN; puede enviarnos el comprobante del resto cuando lo tenga.',
      ],
      [
        'RECEIPT_PAYMENT_REJECTED',
        { folio: 'F-0042', reason: 'El monto no coincide' },
        'No pudimos confirmar su comprobante del pedido F-0042: El monto no coincide. ¿Me puede enviar otro comprobante?',
      ],
      [
        'RECEIPT_PAYMENT_REJECTED',
        { folio: 'F-0042' },
        'No pudimos confirmar su comprobante del pedido F-0042. ¿Me puede enviar otro comprobante?',
      ],
      [
        'RECEIPT_PAYMENT_REJECTED',
        { reason: 'Comprobante ilegible.' },
        'No pudimos confirmar su comprobante de su pedido: Comprobante ilegible. ¿Me puede enviar otro comprobante?',
      ],
    ] as const)('renders %s %j', (key, args, text) => {
      expect(render(key, args)).toBe(text);
    });
  });

  it('shutdown stops claims, wakes polling, drains the active send, idempotent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness([[intent()]]);
    h.sendText.mockImplementation(() =>
      gate.then(() => ({ providerMessageId: 'wamid.9' })),
    );
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.sendText).toHaveBeenCalledTimes(1);
    const stopped = h.worker.onModuleDestroy();
    await flush();
    expect(h.markSent).not.toHaveBeenCalled(); // drain, never cancel
    expect(h.claimBatch).toHaveBeenCalledTimes(1); // no claims after stop
    release();
    await stopped;
    expect(h.markSent).toHaveBeenCalledWith('i1', 'wn', 'wamid.9', LEASE);
    expect(h.worker.onModuleDestroy()).toBe(stopped);
  });

  it('fails closed on a missing lease token: no send, no bookkeeping', async () => {
    const h = harness([[intent({ leaseExpiresAt: undefined })]]);
    h.worker.onApplicationBootstrap();
    await flush();
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.markSent).not.toHaveBeenCalled();
    expect(h.reschedule).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
  });

  it('carries no LLM or AgentRunner authority', () => {
    const source = readFileSync(
      join(__dirname, 'receipt-media-notification.worker.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/AgentRunner|LlmAgent|llm-agent|@ai-sdk/i);
  });
});
