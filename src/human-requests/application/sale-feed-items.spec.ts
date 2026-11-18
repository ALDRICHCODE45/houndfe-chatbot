import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosRequestConfig } from 'axios';
import { of, throwError } from 'rxjs';
import { UpstreamError } from '../../chatbot-api/domain/errors';
import { ChatbotApiHttpClient } from '../../chatbot-api/infrastructure/chatbot-api-http.client';
import type { FeedConsumerLock } from '../domain/human-request-feed';
import { InMemoryHumanRequestFeedStore } from '../infrastructure/in-memory-human-request-feed.store';
import { HumanRequestDeliveryService } from './human-request-delivery.service';
import { HumanRequestFeedConsumer } from './human-request-feed.consumer';

/**
 * Pay in store S2 (odd/tasks/pay-in-store.md): the backend's sale feed items
 * (`requestId: null`, a `saleId`) must never jam the human request feed.
 * Until S3 is enabled every sale item is ACKed STALE with no customer
 * message. Wire → parser → consumer → delivery → ACK, end to end.
 */

const REF = 'wa:5215550001111';
const SALE = '8c1d0000-1111-4222-8333-444455556666';
const HOLD_UNTIL = '2026-11-19T18:30:00.000Z';

const saleWire = (
  deliveryId: string,
  type: string,
  patch: Record<string, unknown> = {},
  payloadPatch: Record<string, unknown> = {},
) => ({
  cursor: `00000000${deliveryId.padStart(4, '0')}`,
  deliveryId,
  type,
  requestId: null,
  saleId: SALE,
  conversationRef: REF,
  payload: {
    saleId: SALE,
    folio: 'V-000123',
    ...(type === 'sale.pickup_expired' ? {} : { holdUntil: HOLD_UNTIL }),
    holdVersion: 2,
    conversationRef: REF,
    ...payloadPatch,
  },
  notBefore: null,
  expiresAt: null,
  ...patch,
});

const cancelledWire = (deliveryId: string, requestId: string | null) => ({
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

describe('sale feed items (pay in store S2)', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const setup = () => {
    const http = new HttpService();
    const feedPages: unknown[] = [];
    const recoveryPages: unknown[] = [];
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
          : next === 410
            ? throwError(() =>
                Object.assign(new Error('gone'), {
                  response: {
                    status: 410,
                    data: { statusCode: 410, code: 'CURSOR_EXPIRED' },
                    headers: {},
                  },
                }),
              )
            : of(response(next));
      }
      if (url === '/chatbot-api/requests') {
        const next = recoveryPages.shift();
        return next === undefined
          ? throwError(() => new Error('no recovery page scripted'))
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
            ackReceivedAt: '2026-11-18T10:00:00.000Z',
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
        sendText: (message: { to: string; text: string }) => {
          sent.push(message);
          return Promise.resolve({ providerMessageId: `wamid.${sent.length}` });
        },
      },
      handoff: { isHumanMode: () => Promise.resolve(false) },
      isWindowOpen: () => Promise.resolve(true),
    });
    const consumer = new HumanRequestFeedConsumer(
      { store, client, delivery, lock: new FakeLock() },
      { sleep: () => Promise.resolve() },
    );
    return {
      client,
      store,
      consumer,
      feedPages,
      recoveryPages,
      acks,
      sent,
    };
  };

  it.each<[string, Record<string, unknown>]>([
    ['sale.pickup_reminder', saleWire('1', 'sale.pickup_reminder')],
    ['sale.pickup_expired', saleWire('2', 'sale.pickup_expired')],
    [
      'sale.pickup_extended (conversationRef null)',
      saleWire(
        '3',
        'sale.pickup_extended',
        { conversationRef: null },
        { conversationRef: null },
      ),
    ],
    ['an unknown sale.* type', saleWire('4', 'sale.something_new')],
    [
      'a sale item without payload',
      saleWire('5', 'sale.pickup_reminder', { payload: null }),
    ],
    [
      'a sale item without saleId',
      saleWire('6', 'sale.pickup_expired', { saleId: undefined }),
    ],
  ])(
    '%s is surfaced as unknown (requestId null accepted), never a rejected page',
    async (_name, raw) => {
      const { client, feedPages } = setup();
      feedPages.push({ items: [raw], nextCursor: '000000000009' });
      await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
        kind: 'ok',
        nextCursor: '000000000009',
        items: [
          {
            type: 'unknown',
            rawType: raw.type,
            cursor: raw.cursor,
            deliveryId: raw.deliveryId,
            raw,
          },
        ],
      });
    },
  );

  it('request.* items still require a requestId: a null one rejects the page as before', async () => {
    const { client, feedPages } = setup();
    feedPages.push({
      items: [cancelledWire('5', null)],
      nextCursor: '000000000005',
    });
    await expect(client.readFeed({ after: 'c' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('a mixed page: every sale item ACKs STALE once with no message, the request item is handled normally, the cursor advances', async () => {
    const { consumer, store, feedPages, acks, sent } = setup();
    await store.saveCursor('000000000000');
    feedPages.push({
      items: [
        saleWire('1', 'sale.pickup_reminder'),
        cancelledWire('2', 'req-2'),
        saleWire(
          '3',
          'sale.pickup_expired',
          { conversationRef: null },
          {
            conversationRef: null,
          },
        ),
        saleWire('4', 'sale.pickup_extended'),
        saleWire('5', 'sale.something_new'),
      ],
      nextCursor: '000000000005',
    });
    await expect(consumer.runOnce()).resolves.toEqual({
      kind: 'page',
      items: 5,
    });
    await expect(store.readCursor()).resolves.toBe('000000000005');
    // Only the request.cancelled reached the customer.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('5215550001111');
    expect(acks.map((a) => [a.deliveryId, a.body.outcome])).toEqual([
      ['1', 'STALE'],
      ['2', 'PROVIDER_ACCEPTED'],
      ['3', 'STALE'],
      ['4', 'STALE'],
      ['5', 'STALE'],
    ]);
    for (const id of ['1', '3', '4'])
      await expect(store.getDelivery(id)).resolves.toMatchObject({
        requestId: null,
        localState: 'STALE',
        ackState: 'ACKED',
        ackOutcome: 'STALE',
      });
    await expect(store.getDelivery('1')).resolves.toMatchObject({
      type: 'sale.pickup_reminder',
    });
    await expect(store.getDelivery('5')).resolves.toMatchObject({
      type: 'sale.something_new',
      localState: 'STALE',
      decision: 'UNKNOWN_TYPE',
    });
    // An expected sale item is not an unknown-type warning.
    const warned = (warn.mock.calls as unknown[][]).map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('sale.pickup_'))).toBe(false);
    expect(warned.some((line) => line.includes('sale.something_new'))).toBe(
      true,
    );
    const logged = (log.mock.calls as unknown[][]).map((c) => String(c[0]));
    expect(
      logged.filter((line) =>
        line.includes('pay in store notices are not enabled'),
      ),
    ).toHaveLength(3);
    // Never log the customer's ref.
    expect([...warned, ...logged].join('\n')).not.toContain('5215550001111');
  });

  it('a redelivered sale item (same deliveryId) is not ACKed or handled twice', async () => {
    const { consumer, store, feedPages, acks, sent } = setup();
    feedPages.push(
      {
        items: [saleWire('1', 'sale.pickup_reminder')],
        nextCursor: '000000000001',
      },
      {
        items: [
          saleWire('1', 'sale.pickup_reminder'),
          saleWire('2', 'sale.pickup_extended'),
        ],
        nextCursor: '000000000002',
      },
    );
    await consumer.runOnce();
    await consumer.runOnce();
    expect(acks.map((a) => a.deliveryId)).toEqual(['1', '2']);
    expect(sent).toEqual([]);
    await expect(store.readCursor()).resolves.toBe('000000000002');
  });

  it('a recovery answer with saleUndeliveredResumeAfter is accepted and the walk completes', async () => {
    const { client, consumer, store, feedPages, recoveryPages } = setup();
    await store.saveCursor('000000000001', '2026-11-01T00:00:00.000Z');
    feedPages.push(410);
    recoveryPages.push({
      items: [],
      nextCursor: '000000000900',
      nextPage: null,
      saleUndeliveredResumeAfter: '000000000100',
    });
    await expect(client.listOpenRequests()).resolves.toMatchObject({
      kind: 'ok',
      nextCursor: '000000000900',
    });
    recoveryPages.push({
      items: [],
      nextCursor: '000000000900',
      nextPage: null,
      saleUndeliveredResumeAfter: '000000000100',
    });
    await expect(consumer.runOnce()).resolves.toMatchObject({
      kind: 'recovered',
    });
    await expect(store.readCursor()).resolves.toBe('000000000900');
  });
});
