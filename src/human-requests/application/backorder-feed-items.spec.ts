import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosRequestConfig } from 'axios';
import { of, throwError } from 'rxjs';
import type { BackorderFeedItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
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
    return { client, store, consumer, feedPages, acks, sent };
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
