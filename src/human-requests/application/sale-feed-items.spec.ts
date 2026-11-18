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
    ...(type === 'sale.pickup_expired' || type === 'sale.pickup_expired_review'
      ? {}
      : { holdUntil: HOLD_UNTIL }),
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

  it('sale.pickup_reminder / _expired / _extended parse as typed sale items (T2: requestId null, saleId, holdVersion)', async () => {
    const { client, feedPages } = setup();
    feedPages.push({
      items: [
        saleWire('1', 'sale.pickup_reminder'),
        saleWire('2', 'sale.pickup_expired', {}, { folio: null }),
        saleWire(
          '3',
          'sale.pickup_extended',
          { conversationRef: null },
          { conversationRef: null },
        ),
      ],
      nextCursor: '000000000009',
    });
    const envelope = (deliveryId: string) => ({
      cursor: `00000000${deliveryId.padStart(4, '0')}`,
      deliveryId,
      requestId: null,
      saleId: SALE,
      notBefore: null,
      expiresAt: null,
    });
    await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
      kind: 'ok',
      nextCursor: '000000000009',
      items: [
        {
          ...envelope('1'),
          type: 'sale.pickup_reminder',
          conversationRef: REF,
          payload: {
            saleId: SALE,
            folio: 'V-000123',
            holdUntil: HOLD_UNTIL,
            holdVersion: 2,
          },
        },
        {
          ...envelope('2'),
          type: 'sale.pickup_expired',
          conversationRef: REF,
          payload: { saleId: SALE, folio: null, holdVersion: 2 },
        },
        {
          ...envelope('3'),
          type: 'sale.pickup_extended',
          conversationRef: null,
          payload: {
            saleId: SALE,
            folio: 'V-000123',
            holdUntil: HOLD_UNTIL,
            holdVersion: 2,
          },
        },
      ],
    });
  });

  it('pay-in-store-templates S2: the new fields parse when present (previousHoldUntil, direction, branchName) and sale.pickup_expired_review is typed', async () => {
    const { client, feedPages } = setup();
    const PREVIOUS = '2026-11-20T18:30:00.000Z';
    feedPages.push({
      items: [
        saleWire(
          '1',
          'sale.pickup_extended',
          {},
          {
            previousHoldUntil: PREVIOUS,
            direction: 'SHORTENED',
            branchName: 'Sucursal Centro',
          },
        ),
        saleWire(
          '2',
          'sale.pickup_reminder',
          {},
          { branchName: 'Sucursal Centro' },
        ),
        saleWire('3', 'sale.pickup_expired', {}, { branchName: null }),
        saleWire(
          '4',
          'sale.pickup_expired_review',
          { conversationRef: null },
          { conversationRef: null, branchName: 'Sucursal Centro' },
        ),
        saleWire('5', 'sale.pickup_expired_review'),
      ],
      nextCursor: '000000000009',
    });
    const envelope = (deliveryId: string, conversationRef: string | null) => ({
      cursor: `00000000${deliveryId.padStart(4, '0')}`,
      deliveryId,
      requestId: null,
      saleId: SALE,
      conversationRef,
      notBefore: null,
      expiresAt: null,
    });
    const common = { saleId: SALE, folio: 'V-000123', holdVersion: 2 };
    await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
      kind: 'ok',
      nextCursor: '000000000009',
      items: [
        {
          ...envelope('1', REF),
          type: 'sale.pickup_extended',
          payload: {
            ...common,
            holdUntil: HOLD_UNTIL,
            previousHoldUntil: PREVIOUS,
            direction: 'SHORTENED',
            branchName: 'Sucursal Centro',
          },
        },
        {
          ...envelope('2', REF),
          type: 'sale.pickup_reminder',
          payload: {
            ...common,
            holdUntil: HOLD_UNTIL,
            branchName: 'Sucursal Centro',
          },
        },
        {
          ...envelope('3', REF),
          type: 'sale.pickup_expired',
          payload: { ...common, branchName: null },
        },
        {
          ...envelope('4', null),
          type: 'sale.pickup_expired_review',
          payload: { ...common, branchName: 'Sucursal Centro' },
        },
        {
          ...envelope('5', REF),
          type: 'sale.pickup_expired_review',
          payload: common,
        },
      ],
    });
  });

  it('pay-in-store-templates S2: an out-of-contract optional field is dropped, never the item', async () => {
    const { client, feedPages } = setup();
    feedPages.push({
      items: [
        saleWire(
          '1',
          'sale.pickup_extended',
          {},
          {
            previousHoldUntil: 'yesterday',
            direction: 'SIDEWAYS',
            branchName: 42,
          },
        ),
      ],
      nextCursor: '000000000009',
    });
    await expect(client.readFeed({ after: 'c' })).resolves.toEqual({
      kind: 'ok',
      nextCursor: '000000000009',
      items: [
        expect.objectContaining({
          type: 'sale.pickup_extended',
          payload: {
            saleId: SALE,
            folio: 'V-000123',
            holdUntil: HOLD_UNTIL,
            holdVersion: 2,
          },
        }),
      ],
    });
  });

  it('a sale item whose top-level conversationRef is missing takes the payload one', async () => {
    const { client, feedPages } = setup();
    feedPages.push({
      items: [saleWire('1', 'sale.pickup_reminder', { conversationRef: null })],
      nextCursor: '000000000009',
    });
    const page = await client.readFeed({ after: 'c' });
    expect(page).toMatchObject({
      kind: 'ok',
      items: [{ type: 'sale.pickup_reminder', conversationRef: REF }],
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown sale.* type', saleWire('4', 'sale.something_new')],
    [
      'a reminder without holdUntil',
      saleWire('7', 'sale.pickup_reminder', {}, { holdUntil: undefined }),
    ],
    [
      'a holdVersion of 0',
      saleWire('8', 'sale.pickup_extended', {}, { holdVersion: 0 }),
    ],
    [
      'a payload saleId that is not the envelope one',
      saleWire('9', 'sale.pickup_expired', {}, { saleId: 'other' }),
    ],
    [
      'a sale item without payload',
      saleWire('5', 'sale.pickup_reminder', { payload: null }),
    ],
    [
      'a sale item without saleId',
      saleWire('6', 'sale.pickup_expired', { saleId: undefined }),
    ],
  ])(
    '%s is surfaced as unknown (STALE), never a rejected page',
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
        saleWire('6', 'sale.pickup_expired_review'),
      ],
      nextCursor: '000000000006',
    });
    await expect(consumer.runOnce()).resolves.toEqual({
      kind: 'page',
      items: 6,
    });
    await expect(store.readCursor()).resolves.toBe('000000000006');
    // Only the request.cancelled reached the customer.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('5215550001111');
    expect(acks.map((a) => [a.deliveryId, a.body.outcome])).toEqual([
      ['1', 'STALE'],
      ['2', 'PROVIDER_ACCEPTED'],
      ['3', 'STALE'],
      ['4', 'STALE'],
      ['5', 'STALE'],
      ['6', 'STALE'],
    ]);
    for (const id of ['1', '3', '4', '6'])
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
    ).toHaveLength(4);
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

  it('the recovery page parser exposes saleUndeliveredResumeAfter (string, null; absent stays absent)', async () => {
    const { client, recoveryPages } = setup();
    const page = (sale?: string | null) => ({
      items: [],
      nextCursor: '000000000900',
      nextPage: null,
      ...(sale === undefined ? {} : { saleUndeliveredResumeAfter: sale }),
    });
    recoveryPages.push(page('000000000100'), page(null), page());
    for (const expected of ['000000000100', null])
      await expect(client.listOpenRequests()).resolves.toMatchObject({
        kind: 'ok',
        nextCursor: '000000000900',
        saleUndeliveredResumeAfter: expected,
      });
    await expect(client.listOpenRequests()).resolves.toEqual({
      kind: 'ok',
      items: [],
      nextCursor: '000000000900',
      nextPage: null,
    });
  });

  it('T2: the recovery resumes from saleUndeliveredResumeAfter when it is the smallest position', async () => {
    const { consumer, store, feedPages, recoveryPages } = setup();
    await store.saveCursor('000000000001', '2026-11-01T00:00:00.000Z');
    feedPages.push(410);
    recoveryPages.push({
      items: [],
      nextCursor: '000000000900',
      nextPage: null,
      saleUndeliveredResumeAfter: '000000000100',
    });
    await expect(consumer.runOnce()).resolves.toMatchObject({
      kind: 'recovered',
    });
    await expect(store.readCursor()).resolves.toBe('000000000100');
  });

  it('T2: the MINIMUM saleUndeliveredResumeAfter seen across the pages wins (a later page may carry a larger one)', async () => {
    const { consumer, store, feedPages, recoveryPages } = setup();
    await store.saveCursor('000000000001', '2026-11-01T00:00:00.000Z');
    feedPages.push(410);
    recoveryPages.push(
      {
        items: [],
        nextCursor: '000000000900',
        nextPage: 'p2',
        saleUndeliveredResumeAfter: '000000000300',
      },
      {
        items: [],
        nextCursor: '000000000950',
        nextPage: 'p3',
        saleUndeliveredResumeAfter: '000000000200',
      },
      {
        items: [],
        nextCursor: '000000000990',
        nextPage: null,
        saleUndeliveredResumeAfter: '000000000500',
      },
    );
    await consumer.runOnce();
    await expect(store.readCursor()).resolves.toBe('000000000200');
  });

  it('T2: a request undeliveredResumeAfter below the sale one still wins; the first nextCursor is kept', async () => {
    const { consumer, store, feedPages, recoveryPages } = setup();
    await store.saveCursor('000000000001', '2026-11-01T00:00:00.000Z');
    feedPages.push(410);
    recoveryPages.push({
      items: [
        {
          id: 'req-1',
          folio: null,
          kind: 'QUESTION',
          subtype: 'UNKNOWN_QUESTION',
          status: 'NEW',
          conversationRef: REF,
          legacyId: null,
          whatsappWindowClosesAt: null,
          cancelReason: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          closedAt: null,
          pendingDeliveries: [],
          undeliveredTruncated: true,
          undeliveredResumeAfter: '000000000050',
        },
      ],
      nextCursor: '000000000900',
      nextPage: null,
      saleUndeliveredResumeAfter: '000000000100',
    });
    await consumer.runOnce();
    await expect(store.readCursor()).resolves.toBe('000000000050');
  });

  it('T2: saleUndeliveredResumeAfter null on every page (all sale items ACKed) leaves nextCursor', async () => {
    const { consumer, store, feedPages, recoveryPages } = setup();
    await store.saveCursor('000000000001', '2026-11-01T00:00:00.000Z');
    feedPages.push(410);
    recoveryPages.push(
      {
        items: [],
        nextCursor: '000000000900',
        nextPage: 'p2',
        saleUndeliveredResumeAfter: null,
      },
      {
        items: [],
        nextCursor: '000000000950',
        nextPage: null,
        saleUndeliveredResumeAfter: null,
      },
    );
    await consumer.runOnce();
    await expect(store.readCursor()).resolves.toBe('000000000900');
  });

  it('a recovery page without the field (backend before pay in store) resumes from nextCursor as before', async () => {
    const { consumer, store, feedPages, recoveryPages } = setup();
    await store.saveCursor('000000000001', '2026-11-01T00:00:00.000Z');
    feedPages.push(410);
    recoveryPages.push({
      items: [],
      nextCursor: '000000000900',
      nextPage: null,
    });
    await consumer.runOnce();
    await expect(store.readCursor()).resolves.toBe('000000000900');
  });

  it.each([
    ['a number', 100],
    ['an empty string', ''],
  ])(
    'a recovery page whose saleUndeliveredResumeAfter is %s is out of contract',
    async (_name, value) => {
      const { client, recoveryPages } = setup();
      recoveryPages.push({
        items: [],
        nextCursor: '000000000900',
        nextPage: null,
        saleUndeliveredResumeAfter: value,
      });
      await expect(client.listOpenRequests()).rejects.toBeInstanceOf(
        UpstreamError,
      );
    },
  );
});
