import { Logger } from '@nestjs/common';
import type {
  DeliveryOutcomeInput,
  FeedItem,
  RecordDeliveryOutcomeResult,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { CheckoutPickupLocation } from '../../chatbot-api/domain/dtos/checkout.dto';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import { WhatsappSendError } from '../../whatsapp/infrastructure/meta-whatsapp.sender';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { HumanRequestDeliveryService } from './human-request-delivery.service';
import {
  SalePickupNoticeService,
  type PayInStoreSaleRecord,
} from './sale-pickup-notice.service';

/**
 * Pay in store S3 (odd/tasks/pay-in-store.md): the sale.pickup_* feed items
 * reach the customer once, with the exact copy, behind PAY_IN_STORE_ENABLED
 * (the handler is wired only when the flag is on). STALE for an overtaken
 * hold version, a paid or cancelled sale, no conversation, or a closed 24 h
 * window (this bot has no template for these notices).
 */

const SENDER = '5215550001111';
const REF = `wa:${SENDER}`;
const SALE = '8c1d0000-1111-4222-8333-444455556666';
const KEY = '7b1d0000-1111-4222-8333-444455556666';
// 12:30 p. m. in Mexico City (UTC-6 in November, no DST).
const HOLD_UNTIL = '2026-11-19T18:30:00.000Z';
// 9:30 a. m. the same local day (the reminder fires 3 h before).
const NOW = new Date('2026-11-19T15:30:00.000Z');
const TU: CustomerStyle = { register: 'tu', emojis: false, tone: 'casual' };

const LOCATION: CheckoutPickupLocation = {
  name: 'Sucursal Centro',
  address: {
    addressLine1: 'Av. Juárez 123',
    addressLine2: null,
    neighborhood: 'Centro',
    municipality: 'Cuauhtémoc',
    state: 'Ciudad de México',
    postalCode: '06000',
    formatted:
      'Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000.',
  },
  hours: {
    timeZone: 'America/Mexico_City',
    days: [],
    summary: 'Lunes a sábado: 09:00–18:00. Domingo: cerrado.',
  },
};
const STORE =
  'Sucursal Centro: Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000. Horario: Lunes a sábado: 09:00–18:00. Domingo: cerrado';

const REMINDER = `Le recordamos que su pedido B-0042 está apartado hasta hoy a las 12:30 p. m. Páselo a recoger y pagar en ${STORE}.`;
const EXPIRED =
  'Su pedido B-0042 se canceló porque venció el plazo para recogerlo y pagarlo en tienda. Si todavía lo quiere, con gusto le ayudo a pedirlo de nuevo.';
const EXTENDED =
  'Le ampliamos el plazo de su pedido B-0042: ahora puede recogerlo y pagarlo hasta el jueves 19 de noviembre a las 12:30 p. m.';

type SaleType =
  | 'sale.pickup_reminder'
  | 'sale.pickup_expired'
  | 'sale.pickup_extended';

const saleItem = (
  deliveryId: string,
  type: SaleType,
  patch: { holdVersion?: number; conversationRef?: string | null } = {},
): FeedItem => {
  const conversationRef =
    patch.conversationRef === undefined ? REF : patch.conversationRef;
  const holdVersion = patch.holdVersion ?? 2;
  const envelope = {
    cursor: `00000000${deliveryId.padStart(4, '0')}`,
    deliveryId,
    requestId: null,
    saleId: SALE,
    conversationRef,
    notBefore: null,
    expiresAt: null,
  };
  return type === 'sale.pickup_expired'
    ? {
        ...envelope,
        type,
        payload: { saleId: SALE, folio: 'B-0042', holdVersion },
      }
    : {
        ...envelope,
        type,
        payload: {
          saleId: SALE,
          folio: 'B-0042',
          holdUntil: HOLD_UNTIL,
          holdVersion,
        },
      };
};

interface Hold {
  paymentIntent: string;
  expiresAt: string | null;
  reminderAt: string | null;
  stage: number;
  version: number;
}

const harness = (options: { withHandler?: boolean } = {}) => {
  const store = new InMemoryHumanRequestFeedStore();
  const acks: Array<{ deliveryId: string; body: DeliveryOutcomeInput }> = [];
  const sent: Array<{ to: string; text: string }> = [];
  const state = {
    human: false,
    window: true,
    style: null as CustomerStyle | null,
    record: {
      saleId: SALE,
      paid: false,
      checkoutKey: KEY,
      pickupLocation: LOCATION,
    } as PayInStoreSaleRecord | null,
    recordFails: false,
    hold: {
      paymentIntent: 'IN_STORE',
      expiresAt: HOLD_UNTIL,
      reminderAt: '2026-11-19T15:30:00.000Z',
      stage: 0,
      version: 2,
    } as Hold | null | undefined,
    holdFails: false,
    sendScript: [] as Error[],
  };
  const statusReads: string[] = [];
  let attempt = 0;
  const handler = new SalePickupNoticeService({
    placedSale: (senderId) => {
      expect(senderId).toBe(SENDER);
      return state.recordFails
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(state.record);
    },
    api: {
      getCheckoutStatus: (key: string) => {
        statusReads.push(key);
        if (state.holdFails) return Promise.reject(new Error('backend down'));
        return Promise.resolve({
          status: 'succeeded',
          checkout: {
            status: 'created',
            customer: {
              resolution: 'existing',
              customerId: '22222222-2222-4222-8222-222222222222',
              firstName: 'Ana',
              lastName: null,
            },
            address: null,
            sale: {
              saleId: SALE,
              folio: 'B-0042',
              paymentStatus: 'CREDIT',
              channel: 'ONLINE',
              deliveryStatus: 'PENDING',
              totalCents: 3000,
              paidCents: 0,
              debtCents: 3000,
              confirmedAt: null,
              discountCents: 0,
              fulfillmentMode: 'PICKUP',
            },
            pickupLocation: LOCATION,
          },
          ...(state.hold === undefined ? {} : { hold: state.hold }),
        } as never);
      },
    },
    isWindowOpen: () => Promise.resolve(state.window),
    customerStyle: () => Promise.resolve(state.style),
    clock: () => NOW,
  });
  const service = new HumanRequestDeliveryService(
    {
      store,
      client: {
        recordDeliveryOutcome: (deliveryId, body) => {
          acks.push({ deliveryId, body });
          return Promise.resolve<RecordDeliveryOutcomeResult>({
            kind: 'ok',
            response: {
              deliveryId,
              outcome: body.outcome,
              attemptId: body.attemptId,
              ackReceivedAt: null,
            },
          });
        },
        listPendingDeliveries: () => Promise.resolve({ kind: 'ok', items: [] }),
      },
      sender: {
        sendText: (message) => {
          sent.push(message);
          const next = state.sendScript.shift();
          if (next !== undefined) return Promise.reject(next);
          return Promise.resolve({ providerMessageId: `wamid.${sent.length}` });
        },
      },
      handoff: { isHumanMode: () => Promise.resolve(state.human) },
      isWindowOpen: () => Promise.resolve(state.window),
      customerStyle: () => Promise.resolve(state.style),
      ...(options.withHandler === false ? {} : { salePickup: handler }),
    },
    {
      clock: () => NOW,
      random: () => 1,
      newAttemptId: () => {
        attempt += 1;
        return `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`;
      },
    },
  );
  return { store, acks, sent, state, service, statusReads };
};

describe('pay in store sale notices (S3)', () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
  });
  afterEach(() => jest.restoreAllMocks());

  const expectLogsSafe = () => {
    for (const line of logged) expect(line).not.toContain(SENDER);
  };

  it.each<[SaleType, string, string]>([
    ['sale.pickup_reminder', REMINDER, 'PICKUP_REMINDER'],
    ['sale.pickup_expired', EXPIRED, 'PICKUP_EXPIRED_NOTICE'],
    ['sale.pickup_extended', EXTENDED, 'PICKUP_EXTENDED_NOTICE'],
  ])(
    '%s sends the exact text once and ACKs PROVIDER_ACCEPTED',
    async (type, text, decision) => {
      const { service, sent, acks, store, statusReads } = harness();
      await service.accept(saleItem('1', type));
      expect(sent).toEqual([{ to: SENDER, text }]);
      expect(acks).toEqual([
        {
          deliveryId: '1',
          body: expect.objectContaining({
            outcome: 'PROVIDER_ACCEPTED',
            providerMessageId: 'wamid.1',
          }) as unknown,
        },
      ]);
      // The live hold was read through our own checkout key.
      expect(statusReads).toEqual([KEY]);
      await expect(store.getDelivery('1')).resolves.toMatchObject({
        localState: 'SENT',
        decision,
        ackState: 'ACKED',
        requestId: null,
        conversationRef: REF,
      });
      // Redelivered (same deliveryId): never sent or ACKed twice.
      await service.accept(saleItem('1', type));
      expect(sent).toHaveLength(1);
      expect(acks).toHaveLength(1);
      expectLogsSafe();
    },
  );

  it.each<[SaleType, string]>([
    [
      'sale.pickup_reminder',
      `Te recordamos que tu pedido B-0042 está apartado hasta hoy a las 12:30 p. m. Pásalo a recoger y pagar en ${STORE}.`,
    ],
    [
      'sale.pickup_expired',
      'Tu pedido B-0042 se canceló porque venció el plazo para recogerlo y pagarlo en tienda. Si todavía lo quieres, con gusto te ayudo a pedirlo de nuevo.',
    ],
    [
      'sale.pickup_extended',
      'Te ampliamos el plazo de tu pedido B-0042: ahora puedes recogerlo y pagarlo hasta el jueves 19 de noviembre a las 12:30 p. m.',
    ],
  ])('%s in tú for a tú customer', async (type, text) => {
    const h = harness();
    h.state.style = TU;
    await h.service.accept(saleItem('1', type));
    expect(h.sent).toEqual([{ to: SENDER, text }]);
  });

  it('the reminder without a known store says «la tienda»', async () => {
    const h = harness();
    h.state.record = { ...h.state.record!, pickupLocation: null };
    await h.service.accept(saleItem('1', 'sale.pickup_reminder'));
    expect(h.sent[0].text).toBe(
      'Le recordamos que su pedido B-0042 está apartado hasta hoy a las 12:30 p. m. Páselo a recoger y pagar en la tienda.',
    );
  });

  const expectStale = async (
    h: ReturnType<typeof harness>,
    decision: string,
  ) => {
    expect(h.sent).toEqual([]);
    expect(h.acks.map((a) => a.body.outcome)).toEqual(['STALE']);
    await expect(h.store.getDelivery('1')).resolves.toMatchObject({
      localState: 'STALE',
      decision,
      ackState: 'ACKED',
    });
  };

  it.each<SaleType>([
    'sale.pickup_reminder',
    'sale.pickup_expired',
    'sale.pickup_extended',
  ])(
    '%s of a lower holdVersion than the live hold is STALE (HOLD_SUPERSEDED)',
    async (type) => {
      const h = harness();
      h.state.hold = { ...h.state.hold!, version: 3 };
      await h.service.accept(saleItem('1', type, { holdVersion: 2 }));
      await expectStale(h, 'HOLD_SUPERSEDED');
    },
  );

  it('an item of the same holdVersion as the live hold is sent', async () => {
    const h = harness();
    h.state.hold = { ...h.state.hold!, version: 2 };
    await h.service.accept(
      saleItem('1', 'sale.pickup_extended', { holdVersion: 2 }),
    );
    expect(h.sent).toHaveLength(1);
  });

  it.each<SaleType>([
    'sale.pickup_reminder',
    'sale.pickup_expired',
    'sale.pickup_extended',
  ])('%s of a paid sale is STALE (SALE_CLOSED)', async (type) => {
    const h = harness();
    h.state.record = { ...h.state.record!, paid: true };
    await h.service.accept(saleItem('1', type));
    await expectStale(h, 'SALE_CLOSED');
    expect(h.statusReads).toEqual([]);
  });

  it.each<SaleType>(['sale.pickup_reminder', 'sale.pickup_extended'])(
    '%s of a cancelled (expired) hold is STALE (SALE_CLOSED)',
    async (type) => {
      const h = harness();
      h.state.hold = { ...h.state.hold!, stage: 2 };
      await h.service.accept(saleItem('1', type));
      await expectStale(h, 'SALE_CLOSED');
    },
  );

  it('the expired notice of an expired hold (stage 2) is sent', async () => {
    const h = harness();
    h.state.hold = { ...h.state.hold!, stage: 2 };
    await h.service.accept(saleItem('1', 'sale.pickup_expired'));
    expect(h.sent).toEqual([{ to: SENDER, text: EXPIRED }]);
  });

  it('no conversationRef is STALE (NO_CONVERSATION), nothing read', async () => {
    const h = harness();
    await h.service.accept(
      saleItem('1', 'sale.pickup_reminder', { conversationRef: null }),
    );
    await expectStale(h, 'NO_CONVERSATION');
    expect(h.statusReads).toEqual([]);
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ['no placed order', (h) => (h.state.record = null)],
    [
      'another placed order',
      (h) =>
        (h.state.record = {
          ...h.state.record!,
          saleId: '9c1d0000-1111-4222-8333-444455556666',
        }),
    ],
    [
      'an order without its checkout key',
      (h) => (h.state.record = { ...h.state.record!, checkoutKey: null }),
    ],
    ['a hold the backend does not report', (h) => (h.state.hold = undefined)],
    ['no hold at all', (h) => (h.state.hold = null)],
  ])(
    'a sale the bot cannot verify (%s) is STALE (SALE_UNKNOWN)',
    async (_name, arrange) => {
      const h = harness();
      arrange(h);
      await h.service.accept(saleItem('1', 'sale.pickup_reminder'));
      await expectStale(h, 'SALE_UNKNOWN');
    },
  );

  it.each<SaleType>([
    'sale.pickup_reminder',
    'sale.pickup_expired',
    'sale.pickup_extended',
  ])(
    '%s with the 24 h window closed is STALE (WINDOW_CLOSED): no template exists',
    async (type) => {
      const h = harness();
      h.state.window = false;
      await h.service.accept(saleItem('1', type));
      await expectStale(h, 'WINDOW_CLOSED');
    },
  );

  it('a 131047 on the send (window closed after planning) is STALE, never a deferral', async () => {
    const h = harness();
    h.state.sendScript = [new WhatsappSendError(400, 131047, 'Re-engagement')];
    await h.service.accept(saleItem('1', 'sale.pickup_reminder'));
    expect(h.acks.map((a) => a.body.outcome)).toEqual(['STALE']);
    await expect(h.store.getDelivery('1')).resolves.toMatchObject({
      localState: 'STALE',
      decision: 'WINDOW_CLOSED',
    });
  });

  it('an uncertain send ACKs DELIVERY_UNKNOWN and is never resent', async () => {
    const h = harness();
    h.state.sendScript = [new Error('socket hang up')];
    await h.service.accept(saleItem('1', 'sale.pickup_reminder'));
    await h.service.accept(saleItem('1', 'sale.pickup_reminder'));
    expect(h.sent).toHaveLength(1);
    expect(h.acks.map((a) => a.body.outcome)).toEqual(['DELIVERY_UNKNOWN']);
  });

  it('a HUMAN session is STALE (HUMAN_SESSION), never DEFERRED_HUMAN_SESSION', async () => {
    const h = harness();
    h.state.human = true;
    await h.service.accept(saleItem('1', 'sale.pickup_reminder'));
    await expectStale(h, 'HUMAN_SESSION');
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ['the placed order read', (h) => (h.state.recordFails = true)],
    ['the live hold read', (h) => (h.state.holdFails = true)],
  ])(
    'a failed %s rejects (the feed retries the item); nothing sent or ACKed',
    async (_name, arrange) => {
      const h = harness();
      arrange(h);
      await expect(
        h.service.accept(saleItem('1', 'sale.pickup_reminder')),
      ).rejects.toThrow();
      expect(h.sent).toEqual([]);
      expect(h.acks).toEqual([]);
      await expect(h.store.getDelivery('1')).resolves.toMatchObject({
        localState: 'RECEIVED',
      });
    },
  );

  it('flag off (no handler wired): typed sale items are STALE as in T1, no message', async () => {
    const h = harness({ withHandler: false });
    for (const [id, type] of [
      ['1', 'sale.pickup_reminder'],
      ['2', 'sale.pickup_expired'],
      ['3', 'sale.pickup_extended'],
    ] as const)
      await h.service.accept(saleItem(id, type));
    expect(h.sent).toEqual([]);
    expect(h.statusReads).toEqual([]);
    expect(h.acks.map((a) => [a.deliveryId, a.body.outcome])).toEqual([
      ['1', 'STALE'],
      ['2', 'STALE'],
      ['3', 'STALE'],
    ]);
    await expect(h.store.getDelivery('1')).resolves.toMatchObject({
      decision: 'UNKNOWN_TYPE',
    });
    expect(
      logged.filter((l) => l.includes('pay in store notices are not enabled')),
    ).toHaveLength(3);
  });
});
