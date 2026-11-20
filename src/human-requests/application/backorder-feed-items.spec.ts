import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosRequestConfig } from 'axios';
import { of, throwError } from 'rxjs';
import type { BackorderFeedItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type {
  OutboundInteractive,
  OutboundTemplate,
} from '../../whatsapp/domain/whatsapp-sender.port';
import { ChatbotApiHttpClient } from '../../chatbot-api/infrastructure/chatbot-api-http.client';
import type { BackorderFeedHandler } from '../domain/backorder-feed';
import {
  ackBodyFor,
  type DeliveryRow,
  type FeedConsumerLock,
} from '../domain/human-request-feed';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { HumanRequestDeliveryService } from './human-request-delivery.service';
import { HumanRequestFeedConsumer } from './human-request-feed.consumer';

/**
 * Restock backorder S15 (odd/tasks/restock-backorder.md, T8): the backend's
 * `backorder.*` feed items (`requestId: null`, NO `saleId` key, the backorder
 * id inside the payload) must never jam the human request feed, even before
 * the real handler exists: they are ACKed STALE with no customer message and
 * never DEFERRED. Wire → parser → consumer → delivery → ACK, end to end.
 */

const REF = 'wa:5215512349901';
const BACKORDER = '0d3c0000-1111-4222-8333-444455556666';
const ATTEMPT = '11111111-2222-4333-8444-555555555555';

const backorderWire = (
  deliveryId: string,
  type: string,
  payloadPatch: Record<string, unknown> = {},
  patch: Record<string, unknown> = {},
) => ({
  cursor: `00000000${deliveryId.padStart(4, '0')}`,
  deliveryId,
  type,
  requestId: null,
  conversationRef: REF,
  payload: {
    backorderId: BACKORDER,
    folio: 'BO-000012',
    productName: 'Croquetas Adulto Raza Grande 18 kg',
    variantName: null,
    quantity: 2,
    branchName: 'Centro',
    customerFirstName: 'Rosa',
    version: 3,
    referencePriceCents: 114900,
    currentPriceCents: 109900,
    finalPriceCents: 109900,
    reservedUntil: '2026-11-21T15:00:00.000Z',
    reminderAt: '2026-11-21T12:00:00.000Z',
    ...payloadPatch,
  },
  notBefore: null,
  expiresAt: null,
  ...patch,
});

const cancelledWire = (deliveryId: string, requestId: string) => ({
  cursor: `00000000${deliveryId.padStart(4, '0')}`,
  deliveryId,
  type: 'request.cancelled',
  requestId,
  conversationRef: REF,
  notBefore: null,
  expiresAt: null,
  payload: { requestId, reason: 'OTHER', cancelledBy: 'STAFF' },
});

const response = (data: unknown, status = 200) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});

class FakeLock implements FeedConsumerLock {
  tryAcquire = () => Promise.resolve(true);
  isHeld = () => Promise.resolve(true);
  release = () => Promise.resolve();
}

describe('backorder feed items (restock backorder S15)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const setup = (
    options: {
      backorder?: BackorderFeedHandler;
      human?: boolean;
      sendText?: (message: { to: string; text: string }) => Promise<{
        providerMessageId: string;
      }>;
      sendInteractive?: (message: OutboundInteractive) => Promise<{
        providerMessageId: string;
        providerMessageIds: string[];
      }>;
      sendTemplate?: (message: OutboundTemplate) => Promise<{
        providerMessageId: string;
      }>;
      ackFails?: boolean;
    } = {},
  ) => {
    const http = new HttpService();
    const feedPages: unknown[] = [];
    const acks: Array<{ deliveryId: string; body: Record<string, unknown> }> =
      [];
    jest.spyOn(http, 'request').mockImplementation(((
      config: AxiosRequestConfig,
    ) => {
      const url = config.url ?? '';
      if (url === '/chatbot-api/feed') {
        const next = feedPages.shift();
        return next === undefined
          ? throwError(() => new Error('no feed page scripted'))
          : of(response(next));
      }
      const ack = /^\/chatbot-api\/deliveries\/([^/]+)\/outcome$/.exec(url);
      if (ack !== null) {
        const body = config.data as Record<string, unknown>;
        const deliveryId = decodeURIComponent(ack[1]);
        acks.push({ deliveryId, body });
        if (options.ackFails === true)
          return throwError(() => new Error('socket hang up'));
        return of(
          response({
            deliveryId,
            outcome: body.outcome,
            attemptId: body.attemptId,
            ackReceivedAt: '2026-11-21T10:00:00.000Z',
          }),
        );
      }
      return throwError(() => new Error(`unexpected HTTP ${url}`));
    }) as HttpService['request']);
    const client = new ChatbotApiHttpClient(
      http,
      new ConfigService({
        chatbotApi: {
          baseUrl: 'https://example.invalid',
          serviceKey: 'svc_test',
          branchId: 'branch',
        },
      }),
      () => Promise.resolve(),
    );
    const store = new InMemoryHumanRequestFeedStore();
    const sent: Array<{ to: string; text: string }> = [];
    const delivery = new HumanRequestDeliveryService({
      store,
      client,
      sender: {
        ...(options.sendInteractive === undefined
          ? {}
          : { sendInteractive: options.sendInteractive }),
        ...(options.sendTemplate === undefined
          ? {}
          : { sendTemplate: options.sendTemplate }),
        sendText:
          options.sendText ??
          ((message: { to: string; text: string }) => {
            sent.push(message);
            return Promise.resolve({
              providerMessageId: `wamid.${sent.length}`,
            });
          }),
      },
      handoff: { isHumanMode: () => Promise.resolve(options.human === true) },
      isWindowOpen: () => Promise.resolve(true),
      ...(options.backorder === undefined
        ? {}
        : { backorder: options.backorder }),
    });
    const consumer = new HumanRequestFeedConsumer(
      { store, client, delivery, lock: new FakeLock() },
      { sleep: () => Promise.resolve() },
    );
    return { client, store, consumer, feedPages, acks, sent, delivery };
  };

  it('parses backorder.* as typed items: requestId null, no saleId key, loose common payload, every other member kept', async () => {
    const { client, feedPages } = setup();
    feedPages.push({
      items: [
        backorderWire('1', 'backorder.reserved'),
        backorderWire(
          '2',
          'backorder.future',
          { somethingNew: { nested: true }, version: undefined },
          { conversationRef: null },
        ),
      ],
      nextCursor: '000000000009',
    });
    const page = await client.readFeed({ after: 'c' });
    expect(page.kind).toBe('ok');
    if (page.kind !== 'ok') return;
    const [reserved, future] = page.items as BackorderFeedItem[];
    expect(reserved).toMatchObject({
      type: 'backorder.reserved',
      cursor: '000000000001',
      deliveryId: '1',
      requestId: null,
      conversationRef: REF,
      notBefore: null,
      expiresAt: null,
      payload: {
        backorderId: BACKORDER,
        folio: 'BO-000012',
        productName: 'Croquetas Adulto Raza Grande 18 kg',
        variantName: null,
        quantity: 2,
        branchName: 'Centro',
        customerFirstName: 'Rosa',
        version: 3,
        raw: {
          finalPriceCents: 109900,
          reminderAt: '2026-11-21T12:00:00.000Z',
        },
      },
    });
    expect(reserved).not.toHaveProperty('saleId');
    expect(future).toMatchObject({
      type: 'backorder.future',
      conversationRef: null,
      payload: { backorderId: BACKORDER, version: null },
    });
  });

  it('a page mixing a request item and a backorder.reserved item parses; the backorder item is ACKed STALE with no customer message', async () => {
    const { consumer, feedPages, acks, sent, store } = setup();
    feedPages.push({
      items: [
        cancelledWire('10', '8c1d0000-aaaa-4bbb-8ccc-ddddeeeeffff'),
        backorderWire('11', 'backorder.reserved'),
      ],
      nextCursor: '000000000011',
    });
    await expect(consumer.runOnce()).resolves.toEqual({
      kind: 'page',
      items: 2,
    });
    // The request item behaves as always (its cancel notice is the only text).
    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toMatch(/Croquetas|BO-000012/);
    expect(acks.find((a) => a.deliveryId === '11')?.body).toEqual({
      outcome: 'STALE',
      attemptId: acks.find((a) => a.deliveryId === '11')?.body.attemptId,
      attemptedAt: acks.find((a) => a.deliveryId === '11')?.body.attemptedAt,
    });
    expect(acks.find((a) => a.deliveryId === '10')?.body.outcome).toBe(
      'PROVIDER_ACCEPTED',
    );
    expect(await store.readCursor()).toBe('000000000011');
  });

  it('an unknown future backorder type parses and is ACKed STALE (nothing sent)', async () => {
    const { consumer, feedPages, acks, sent } = setup();
    feedPages.push({
      items: [
        backorderWire('12', 'backorder.future', { brandNewMember: [1, 2, 3] }),
      ],
      nextCursor: '000000000012',
    });
    await expect(consumer.runOnce()).resolves.toEqual({
      kind: 'page',
      items: 1,
    });
    expect(sent).toEqual([]);
    expect(acks.map((a) => [a.deliveryId, a.body.outcome])).toEqual([
      ['12', 'STALE'],
    ]);
  });

  it('a malformed backorder item (no payload / no backorderId) is surfaced as unknown and ACKed STALE, never a rejected page', async () => {
    const { client, consumer, feedPages, acks, sent } = setup();
    const noPayload = backorderWire(
      '13',
      'backorder.reserved',
      {},
      {
        payload: null,
      },
    );
    feedPages.push({ items: [noPayload], nextCursor: '000000000013' });
    await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
      kind: 'ok',
      nextCursor: '000000000013',
      items: [
        {
          type: 'unknown',
          rawType: 'backorder.reserved',
          cursor: noPayload.cursor,
          deliveryId: '13',
          raw: noPayload,
        },
      ],
    });
    feedPages.push({
      items: [
        backorderWire('14', 'backorder.reserved', { backorderId: undefined }),
      ],
      nextCursor: '000000000014',
    });
    await consumer.runOnce();
    expect(sent).toEqual([]);
    expect(acks.map((a) => [a.deliveryId, a.body.outcome])).toEqual([
      ['14', 'STALE'],
    ]);
  });

  describe('with a handler registered (T5 seam)', () => {
    const handler = (plan: ReturnType<BackorderFeedHandler['plan']>) => ({
      plan: jest.fn(() => plan),
    });

    it('a send plan goes out as a BOT notice and is ACKed PROVIDER_ACCEPTED', async () => {
      const backorder = handler(
        Promise.resolve({
          action: 'send',
          decision: 'REMINDER_SENT',
          senderId: '5215512349901',
          text: 'Su pedido llegó',
        }),
      );
      const { consumer, feedPages, acks, sent } = setup({ backorder });
      feedPages.push({
        items: [backorderWire('20', 'backorder.reserved')],
        nextCursor: '000000000020',
      });
      await consumer.runOnce();
      expect(backorder.plan).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([{ to: '5215512349901', text: 'Su pedido llegó' }]);
      expect(acks[0].body).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.1',
      });
    });

    it('a stale plan is ACKed STALE without sending', async () => {
      const backorder = handler(
        Promise.resolve({ action: 'stale', decision: 'NO_CONVERSATION' }),
      );
      const { consumer, feedPages, acks, sent } = setup({ backorder });
      feedPages.push({
        items: [backorderWire('21', 'backorder.reservation_expired')],
        nextCursor: '000000000021',
      });
      await consumer.runOnce();
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.body.outcome)).toEqual(['STALE']);
    });

    it('never DEFERRED: a closed window (Meta 131047) is ACKed STALE', async () => {
      const backorder = handler(
        Promise.resolve({
          action: 'send',
          decision: 'REMINDER_SENT',
          senderId: '5215512349901',
          text: 'Su pedido llegó',
        }),
      );
      const { consumer, feedPages, acks } = setup({
        backorder,
        sendText: () =>
          Promise.reject(
            Object.assign(new Error('window closed'), {
              graphErrorCode: 131047,
            }),
          ),
      });
      feedPages.push({
        items: [backorderWire('22', 'backorder.reserved')],
        nextCursor: '000000000022',
      });
      await consumer.runOnce();
      expect(acks.map((a) => a.body.outcome)).toEqual(['STALE']);
    });

    it('never DEFERRED: a HUMAN conversation is ACKed STALE, nothing sent', async () => {
      const backorder = handler(
        Promise.resolve({
          action: 'send',
          decision: 'REMINDER_SENT',
          senderId: '5215512349901',
          text: 'Su pedido llegó',
        }),
      );
      const { consumer, feedPages, acks, sent } = setup({
        backorder,
        human: true,
      });
      feedPages.push({
        items: [backorderWire('23', 'backorder.reserved')],
        nextCursor: '000000000023',
      });
      await consumer.runOnce();
      expect(sent).toEqual([]);
      expect(acks.map((a) => a.body.outcome)).toEqual(['STALE']);
    });
  });

  describe('T5a: buttons, PROVIDER_REJECTED and its stored reason (S9, S13)', () => {
    const BUTTONS = [
      { id: `backorder_confirm:${BACKORDER}`, title: 'Confirmar pedido' },
      {
        id: `backorder_cancel:pick:${BACKORDER}`,
        title: 'Ya no lo quiero',
      },
    ];
    const sendPlan = (extra: Record<string, unknown> = {}) => ({
      plan: jest.fn(() =>
        Promise.resolve({
          action: 'send' as const,
          decision: 'BACKORDER_RESERVED_NOTICE' as const,
          senderId: '5215512349901',
          text: 'Ya llegó su pedido BO-000012. ¿Lo confirmamos?',
          ...extra,
        }),
      ),
    });
    const wire = (id: string, type = 'backorder.reserved') => ({
      items: [backorderWire(id, type)],
      nextCursor: `0000000000${id}`,
    });
    const refusal = (status: number) =>
      Object.assign(new Error('Meta refused'), {
        name: 'WhatsappSendError',
        status,
        stage: 'send',
      });
    const interactive = () => {
      const calls: OutboundInteractive[] = [];
      return {
        calls,
        sendInteractive: (message: OutboundInteractive) => {
          calls.push(message);
          return Promise.resolve({
            providerMessageId: 'wamid.btn',
            providerMessageIds: ['wamid.btn'],
          });
        },
      };
    };

    it('a plan with buttons goes out as an interactive message, not as text', async () => {
      const buttons = interactive();
      const { consumer, feedPages, acks, sent } = setup({
        backorder: sendPlan({
          buttons: BUTTONS,
          shortBody: '¿Lo confirmamos?',
        }),
        sendInteractive: buttons.sendInteractive,
      });
      feedPages.push(wire('30'));
      await consumer.runOnce();
      expect(sent).toEqual([]);
      expect(buttons.calls).toEqual([
        {
          to: '5215512349901',
          body: 'Ya llegó su pedido BO-000012. ¿Lo confirmamos?',
          shortBody: '¿Lo confirmamos?',
          interactive: { type: 'buttons', buttons: BUTTONS },
        },
      ]);
      expect(acks[0].body).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        providerMessageId: 'wamid.btn',
      });
    });

    it('a sender without interactive support sends the plain text', async () => {
      const { consumer, feedPages, sent, acks } = setup({
        backorder: sendPlan({ buttons: BUTTONS }),
      });
      feedPages.push(wire('31'));
      await consumer.runOnce();
      expect(sent).toHaveLength(1);
      expect(acks[0].body.outcome).toBe('PROVIDER_ACCEPTED');
    });

    it('a rejected plan is ACKed PROVIDER_REJECTED with its reason, persisted and replayed verbatim', async () => {
      const backorder = {
        plan: jest.fn(() =>
          Promise.resolve({
            action: 'rejected' as const,
            decision: 'TEMPLATE_NOT_APPROVED' as const,
            reason: 'TEMPLATE_NOT_APPROVED',
          }),
        ),
      };
      const { consumer, feedPages, acks, sent, store } = setup({
        backorder,
        ackFails: true,
      });
      feedPages.push(wire('32'));
      await expect(consumer.runOnce()).resolves.toEqual({
        kind: 'page',
        items: 1,
      });
      expect(sent).toEqual([]);
      expect(acks[0].body).toEqual({
        outcome: 'PROVIDER_REJECTED',
        attemptId: expect.any(String) as unknown,
        attemptedAt: expect.any(String) as unknown,
        reason: 'TEMPLATE_NOT_APPROVED',
      });
      expect(acks[0].body).not.toHaveProperty('providerMessageId');
      // The ACK failed (socket hang up): the row keeps what to replay.
      await expect(store.getDelivery('32')).resolves.toMatchObject({
        localState: 'STALE',
        decision: 'TEMPLATE_NOT_APPROVED',
        ackState: 'PENDING',
        ackOutcome: 'PROVIDER_REJECTED',
        ackReason: 'TEMPLATE_NOT_APPROVED',
      });
    });

    it('the durable ACK sweep resends the identical PROVIDER_REJECTED body', async () => {
      const backorder = {
        plan: jest.fn(() =>
          Promise.resolve({
            action: 'rejected' as const,
            decision: 'NO_CONVERSATION' as const,
            reason: 'NO_CONVERSATION',
          }),
        ),
      };
      const { consumer, feedPages, acks, delivery } = setup({
        backorder,
        ackFails: true,
      });
      feedPages.push(wire('33'));
      await consumer.runOnce();
      const first = acks[0].body;
      // Replay of the due ACK (the maintenance worker's sweep).
      await delivery.sweepAcks();
      await delivery.sweepAcks();
      expect(acks.length).toBeGreaterThanOrEqual(1);
      for (const ack of acks) expect(ack.body).toEqual(first);
    });

    describe('staffAlert plans (reserved / reminder)', () => {
      it('a HUMAN conversation: PROVIDER_REJECTED HUMAN_SESSION, nothing sent', async () => {
        const { consumer, feedPages, acks, sent, store } = setup({
          backorder: sendPlan({ staffAlert: true, buttons: BUTTONS }),
          human: true,
        });
        feedPages.push(wire('34'));
        await consumer.runOnce();
        expect(sent).toEqual([]);
        expect(acks[0].body).toMatchObject({
          outcome: 'PROVIDER_REJECTED',
          reason: 'HUMAN_SESSION',
        });
        await expect(store.getDelivery('34')).resolves.toMatchObject({
          localState: 'STALE',
          decision: 'HUMAN_SESSION',
          ackReason: 'HUMAN_SESSION',
        });
      });

      it('without staffAlert a HUMAN conversation stays STALE', async () => {
        const { consumer, feedPages, acks } = setup({
          backorder: sendPlan(),
          human: true,
        });
        feedPages.push(wire('35', 'backorder.reservation_expired'));
        await consumer.runOnce();
        expect(acks.map((a) => a.body.outcome)).toEqual(['STALE']);
        expect(acks[0].body).not.toHaveProperty('reason');
      });

      it('the window closed at send time (131047): PROVIDER_REJECTED WINDOW_CLOSED', async () => {
        const { consumer, feedPages, acks } = setup({
          backorder: sendPlan({ staffAlert: true }),
          sendText: () =>
            Promise.reject(
              Object.assign(new Error('window'), { graphErrorCode: 131047 }),
            ),
        });
        feedPages.push(wire('36'));
        await consumer.runOnce();
        expect(acks[0].body).toMatchObject({
          outcome: 'PROVIDER_REJECTED',
          reason: 'WINDOW_CLOSED',
        });
      });

      it('a message Meta definitely refuses (4xx): PROVIDER_REJECTED UNREACHABLE', async () => {
        const buttons = interactive();
        const { consumer, feedPages, acks, store } = setup({
          backorder: sendPlan({ staffAlert: true, buttons: BUTTONS }),
          sendInteractive: () => Promise.reject(refusal(400)),
        });
        feedPages.push(wire('37'));
        await consumer.runOnce();
        expect(buttons.calls).toEqual([]);
        expect(acks[0].body).toMatchObject({
          outcome: 'PROVIDER_REJECTED',
          reason: 'UNREACHABLE',
        });
        await expect(store.getDelivery('37')).resolves.toMatchObject({
          decision: 'SEND_REFUSED',
          ackReason: 'UNREACHABLE',
        });
      });

      it('an uncertain send (timeout / 5xx) is DELIVERY_UNKNOWN: never rejected, never retried', async () => {
        const { consumer, feedPages, acks } = setup({
          backorder: sendPlan({ staffAlert: true }),
          sendText: () => Promise.reject(refusal(503)),
        });
        feedPages.push(wire('38'));
        await consumer.runOnce();
        expect(acks.map((a) => a.body.outcome)).toEqual(['DELIVERY_UNKNOWN']);
      });

      it('a template Meta refuses: PROVIDER_REJECTED TEMPLATE_NOT_APPROVED', async () => {
        const { consumer, feedPages, acks, store } = setup({
          backorder: sendPlan({
            staffAlert: true,
            template: {
              templateName: 'pedido_reposicion_llego',
              languageCode: 'es_MX',
              bodyParameters: ['Rosa'],
              refusedDecision: 'TEMPLATE_NOT_APPROVED',
            },
          }),
          sendTemplate: () => Promise.reject(refusal(404)),
        });
        feedPages.push(wire('39'));
        await consumer.runOnce();
        expect(acks[0].body).toMatchObject({
          outcome: 'PROVIDER_REJECTED',
          reason: 'TEMPLATE_NOT_APPROVED',
        });
        await expect(store.getDelivery('39')).resolves.toMatchObject({
          decision: 'TEMPLATE_NOT_APPROVED',
          ackReason: 'TEMPLATE_NOT_APPROVED',
        });
      });

      it('an approved template goes out as a template and is ACKed PROVIDER_ACCEPTED', async () => {
        const templates: OutboundTemplate[] = [];
        const { consumer, feedPages, acks, sent } = setup({
          backorder: sendPlan({
            staffAlert: true,
            template: {
              templateName: 'pedido_reposicion_llego',
              languageCode: 'es_MX',
              bodyParameters: ['Rosa', 'BO-000012'],
              refusedDecision: 'TEMPLATE_NOT_APPROVED',
            },
          }),
          sendTemplate: (message) => {
            templates.push(message);
            return Promise.resolve({ providerMessageId: 'wamid.tpl' });
          },
        });
        feedPages.push(wire('40'));
        await consumer.runOnce();
        expect(sent).toEqual([]);
        expect(templates).toEqual([
          {
            to: '5215512349901',
            templateName: 'pedido_reposicion_llego',
            languageCode: 'es_MX',
            bodyParameters: ['Rosa', 'BO-000012'],
          },
        ]);
        expect(acks[0].body).toMatchObject({
          outcome: 'PROVIDER_ACCEPTED',
          providerMessageId: 'wamid.tpl',
        });
      });
    });

    it('a template refused on a notice without staffAlert (expired / lost) is STALE TEMPLATE_NOT_APPROVED', async () => {
      const { consumer, feedPages, acks, store } = setup({
        backorder: sendPlan({
          decision: 'BACKORDER_EXPIRED_NOTICE',
          template: {
            templateName: 'pedido_reposicion_vencido',
            languageCode: 'es_MX',
            bodyParameters: ['BO-000012', 'Croquetas'],
            refusedDecision: 'TEMPLATE_NOT_APPROVED',
          },
        }),
        sendTemplate: () => Promise.reject(refusal(404)),
      });
      feedPages.push(wire('41', 'backorder.reservation_expired'));
      await consumer.runOnce();
      expect(acks.map((a) => a.body.outcome)).toEqual(['STALE']);
      await expect(store.getDelivery('41')).resolves.toMatchObject({
        decision: 'TEMPLATE_NOT_APPROVED',
        ackReason: null,
      });
    });

    it('a sent message clears nothing it should keep: PROVIDER_ACCEPTED rows carry no reason', async () => {
      const { consumer, feedPages, store } = setup({
        backorder: sendPlan({ staffAlert: true }),
      });
      feedPages.push(wire('42'));
      await consumer.runOnce();
      await expect(store.getDelivery('42')).resolves.toMatchObject({
        localState: 'SENT',
        ackReason: null,
      });
    });

    it('request and sale items are untouched: a request cancel still sends text and ACKs PROVIDER_ACCEPTED', async () => {
      const { consumer, feedPages, acks, sent } = setup({
        backorder: sendPlan({ staffAlert: true }),
      });
      feedPages.push({
        items: [cancelledWire('43', '8c1d0000-aaaa-4bbb-8ccc-ddddeeeeffff')],
        nextCursor: '000000000043',
      });
      await consumer.runOnce();
      expect(sent).toHaveLength(1);
      expect(acks[0].body).toMatchObject({ outcome: 'PROVIDER_ACCEPTED' });
      expect(acks[0].body).not.toHaveProperty('reason');
    });
  });

  describe('ackBodyFor safety net', () => {
    const row = (type: string, ackOutcome: string): DeliveryRow =>
      ({
        deliveryId: 'd1',
        cursor: 'c1',
        type,
        requestId: null,
        conversationRef: REF,
        item:
          type === 'unknown'
            ? {
                type: 'unknown',
                rawType: 'x',
                cursor: 'c1',
                deliveryId: 'd1',
                raw: {},
              }
            : {
                type,
                cursor: 'c1',
                deliveryId: 'd1',
                requestId: null,
                conversationRef: REF,
                notBefore: null,
                expiresAt: null,
                payload: { backorderId: BACKORDER, raw: {} },
              },
        attemptId: ATTEMPT,
        attemptedAt: '2026-11-21T10:00:00.000Z',
        providerMessageId: null,
        ackOutcome,
      }) as unknown as DeliveryRow;

    it.each(['DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION'])(
      'a backorder row owing %s sends STALE instead (the backend answers 422)',
      (outcome) => {
        expect(ackBodyFor(row('backorder.reserved', outcome))).toEqual({
          outcome: 'STALE',
          attemptId: ATTEMPT,
          attemptedAt: '2026-11-21T10:00:00.000Z',
        });
      },
    );

    it('PROVIDER_REJECTED carries its stored reason; without one the body is invalid', () => {
      const rejected = row('backorder.reserved', 'PROVIDER_REJECTED');
      expect(
        ackBodyFor({ ...rejected, ackReason: 'TEMPLATE_NOT_APPROVED' }),
      ).toEqual({
        outcome: 'PROVIDER_REJECTED',
        attemptId: ATTEMPT,
        attemptedAt: '2026-11-21T10:00:00.000Z',
        reason: 'TEMPLATE_NOT_APPROVED',
      });
      expect(ackBodyFor({ ...rejected, ackReason: null })).toBeNull();
      expect(
        ackBodyFor({ ...rejected, ackReason: 'X', attemptedAt: null }),
      ).toBeNull();
    });

    it('a request row keeps its deferral body', () => {
      expect(
        ackBodyFor(row('request.cancelled', 'DEFERRED_WINDOW_CLOSED')),
      ).toEqual({
        outcome: 'DEFERRED_WINDOW_CLOSED',
        attemptId: ATTEMPT,
        attemptedAt: '2026-11-21T10:00:00.000Z',
      });
    });
  });
});
