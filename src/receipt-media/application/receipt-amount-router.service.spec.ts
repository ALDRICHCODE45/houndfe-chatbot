import type { ReceiptAmountPointer } from '../../conversation/domain/conversation-store';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../domain/receipt-media.types';
import {
  ReceiptAmountRouterService,
  type ReceiptAmountRouteInput,
} from './receipt-amount-router.service';

const SENDER = '+5215512345678';
const WEBHOOK = 'wamid.TESTWEBHOOK01';
const POINTER: ReceiptAmountPointer = {
  receiptMediaId: '11111111-2222-4333-8444-555555555555',
  saleId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  receiptVersion: '7',
};
const RECEIPT = { id: POINTER.receiptMediaId } as ReceiptMediaRow;
const INTENT = { id: 'intent-1' } as ReceiptMediaOutboxRow;
const SUCCESS = {
  proposed: { kind: 'proposed', receipt: RECEIPT, intent: INTENT },
  started: { kind: 'started', receipt: RECEIPT, intent: INTENT },
  rejected: { kind: 'rejected', receipt: RECEIPT, intent: INTENT },
  cancelled: { kind: 'cancelled', receipt: RECEIPT, intent: INTENT },
} as const;

/** The four routed texts with their exact store operation. */
const ROUTES = [
  ['$1,234.50', 'proposeAmount'],
  ['sí', 'startAttachment'],
  ['no', 'rejectProposedAmount'],
  ['cancelar', 'cancelReceipt'],
] as const;

/** ODD-4D: malformed/unrecognized valid-string texts with no routing plan. */
const MALFORMED_TEXTS = [
  'hola',
  '',
  '   ',
  'sin monto',
  '$1,234.50 y 999',
  '1234,50',
  '0',
  '-1234.50',
  'hola 1234',
  'no cancelar',
  'sí no',
  '1234.5',
] as const;

const stateOf = (data: unknown) => ({
  senderId: SENDER,
  lastMessageAt: '',
  data,
});
const pointerState = (pointer: unknown) =>
  stateOf({ receiptAmountPointer: pointer });

function routerFixture(state: unknown = pointerState(POINTER)) {
  const conversations = { get: jest.fn().mockResolvedValue(state) };
  const store = {
    proposeAmount: jest.fn(),
    rejectProposedAmount: jest.fn(),
    cancelReceipt: jest.fn(),
    startAttachment: jest.fn(),
  };
  return {
    router: new ReceiptAmountRouterService(conversations, store),
    conversations,
    store,
  };
}

const INPUT = (text: string): ReceiptAmountRouteInput => ({
  senderId: SENDER,
  sourceWebhookMessageId: WEBHOOK,
  text,
});

describe('ReceiptAmountRouterService.route', () => {
  it.each([
    ['$1,234.50', 'proposeAmount', 'proposed'],
    ['1234', 'proposeAmount', 'proposed'],
    ['1234 pesos con 50 centavos', 'proposeAmount', 'proposed'],
    ['sí', 'startAttachment', 'started'],
    ['Confirmo', 'startAttachment', 'started'],
    ['ok', 'startAttachment', 'started'],
    ['dale', 'startAttachment', 'started'],
    ['va', 'startAttachment', 'started'],
    ['no', 'rejectProposedAmount', 'rejected'],
    ['rechazo', 'rejectProposedAmount', 'rejected'],
    ['Rechazar', 'rejectProposedAmount', 'rejected'],
    ['otro', 'rejectProposedAmount', 'rejected'],
    ['cambiar', 'rejectProposedAmount', 'rejected'],
    ['cancelar', 'cancelReceipt', 'cancelled'],
    ['Cancela', 'cancelReceipt', 'cancelled'],
    ['cancelo', 'cancelReceipt', 'cancelled'],
    ['cancel', 'cancelReceipt', 'cancelled'],
    ['1234 cancelar', 'cancelReceipt', 'cancelled'],
    ['sí 1234', 'startAttachment', 'started'],
    ['no 1234.50', 'rejectProposedAmount', 'rejected'],
    ['1234 pesos cancelar', 'cancelReceipt', 'cancelled'],
  ])('routes %j through %s', async (text, op, kind) => {
    const { router, store } = routerFixture();
    store[op as keyof typeof store].mockResolvedValue(
      SUCCESS[kind as keyof typeof SUCCESS],
    );
    const outcome = await router.route(INPUT(text));
    expect(outcome).toEqual({ kind, receipt: RECEIPT, intent: INTENT });
    expect(store[op as keyof typeof store]).toHaveBeenCalledTimes(1);
    expect(store[op as keyof typeof store]).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: SENDER,
        sourceWebhookMessageId: WEBHOOK,
        receiptMediaId: POINTER.receiptMediaId,
        capturedSaleId: POINTER.saleId,
        expectedReceiptVersion: POINTER.receiptVersion,
        expectedPointer: POINTER,
      }),
    );
    for (const sibling of Object.keys(store).filter((k) => k !== op)) {
      expect(store[sibling as keyof typeof store]).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      '$1,234.50',
      'proposeAmount',
      { expectedReceiptStatus: 'AWAITING_AMOUNT', cents: 123450 },
    ],
    [
      'sí',
      'startAttachment',
      { expectedReceiptStatus: 'AWAITING_CONFIRMATION' },
    ],
    [
      'no',
      'rejectProposedAmount',
      { expectedReceiptStatus: 'AWAITING_CONFIRMATION' },
    ],
    ['cancelar', 'cancelReceipt', {}],
  ])('%s propagates the exact %s fence arguments', async (text, op, extra) => {
    const { router, store } = routerFixture();
    store[op as keyof typeof store].mockResolvedValue(SUCCESS.proposed);
    await router.route(INPUT(text));
    const calls = store[op as keyof typeof store].mock
      .calls as unknown as Array<[Record<string, unknown>]>;
    const arg = calls[0][0];
    expect(arg).toEqual({
      sourceWebhookMessageId: WEBHOOK,
      senderId: SENDER,
      receiptMediaId: POINTER.receiptMediaId,
      capturedSaleId: POINTER.saleId,
      expectedReceiptVersion: '7',
      expectedPointer: POINTER,
      ...extra,
    });
    if (op === 'cancelReceipt') {
      expect(Object.hasOwn(arg, 'expectedReceiptStatus')).toBe(false);
    }
  });

  it.each(ROUTES)(
    'preserves the exact store replayed outcome for %s',
    async (text, op) => {
      const { router, store } = routerFixture();
      const replayed = {
        kind: 'replayed',
        receipt: RECEIPT,
        intent: INTENT,
      } as const;
      store[op].mockResolvedValue(replayed);
      expect(await router.route(INPUT(text))).toBe(replayed);
    },
  );

  it.each(ROUTES)(
    'returns a terminal store-fenced outcome for %s without siblings',
    async (text, op) => {
      const { router, store } = routerFixture();
      store[op].mockResolvedValue({ kind: 'fenced' });
      expect(await router.route(INPUT(text))).toEqual({ kind: 'fenced' });
      expect(store[op]).toHaveBeenCalledTimes(1);
      for (const sibling of Object.keys(store).filter((k) => k !== op)) {
        expect(store[sibling as keyof typeof store]).not.toHaveBeenCalled();
      }
    },
  );

  it.each(MALFORMED_TEXTS)(
    'ODD-4D: malformed or ambiguous text %j with a valid pointer is unrecognized',
    async (text) => {
      const { router, store, conversations } = routerFixture();
      expect(await router.route(INPUT(text))).toEqual({ kind: 'unrecognized' });
      expect(conversations.get).toHaveBeenCalledTimes(1);
      for (const op of Object.values(store)) expect(op).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['state null', null],
    ['pointer missing', stateOf({})],
    ['pointer null', pointerState(null)],
    ['version zero', pointerState({ ...POINTER, receiptVersion: '0' })],
    ['empty saleId', pointerState({ ...POINTER, saleId: '' })],
    ['extra key', pointerState({ ...POINTER, extra: true })],
    ['missing keys', pointerState({ receiptVersion: '7' })],
  ])(
    'ODD-4D: malformed text with a %s stays fenced after one read',
    async (_label, state) => {
      const { router, store, conversations } = routerFixture(state);
      expect(await router.route(INPUT('hola'))).toEqual({ kind: 'fenced' });
      expect(conversations.get).toHaveBeenCalledTimes(1);
      for (const op of Object.values(store)) expect(op).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['state null', null],
    ['pointer missing', stateOf({})],
    ['pointer null', pointerState(null)],
    ['version zero', pointerState({ ...POINTER, receiptVersion: '0' })],
    ['empty saleId', pointerState({ ...POINTER, saleId: '' })],
    ['extra key', pointerState({ ...POINTER, extra: true })],
    ['missing keys', pointerState({ receiptVersion: '7' })],
  ])('never reaches the store for a %s', async (_label, state) => {
    const { router, store, conversations } = routerFixture(state);
    expect(await router.route(INPUT('$1,234.50'))).toEqual({ kind: 'fenced' });
    expect(conversations.get).toHaveBeenCalledTimes(1);
    for (const op of Object.values(store)) expect(op).not.toHaveBeenCalled();
  });

  it('fences closed without any store call when the sender or webhook id is empty', async () => {
    const { router, store, conversations } = routerFixture();
    for (const input of [
      { ...INPUT('sí'), senderId: '' },
      { ...INPUT('sí'), sourceWebhookMessageId: '' },
    ]) {
      expect(await router.route(input)).toEqual({ kind: 'fenced' });
    }
    expect(conversations.get).not.toHaveBeenCalled();
    for (const op of Object.values(store)) expect(op).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => 'sí' }],
    ['an array', ['sí']],
    ['a number', 1234.5],
    ['a boolean', true],
    ['a symbol', Symbol('sí')],
  ])('fences closed for non-string text %s', async (_label, text) => {
    const { router, store, conversations } = routerFixture();
    const input = {
      senderId: SENDER,
      sourceWebhookMessageId: WEBHOOK,
      text,
    } as unknown as ReceiptAmountRouteInput;
    expect(await router.route(input)).toEqual({ kind: 'fenced' });
    expect(conversations.get).not.toHaveBeenCalled();
    for (const op of Object.values(store)) expect(op).not.toHaveBeenCalled();
  });
});
