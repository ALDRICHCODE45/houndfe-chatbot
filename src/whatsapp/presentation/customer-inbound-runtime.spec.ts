import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import { PG_POOL } from '../../database/postgres-pool.provider';
import { HUMAN_HANDOFF_SERVICE_TOKEN } from '../../sale-flow/infrastructure/real-tool-registry';
import { RECENT_OUTBOUND } from '../domain/recent-outbound.store';
import { RestockInboundCapture } from '../application/restock-inbound-capture';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import { customerInboundCaptureProvider } from '../infrastructure/customer-inbound-capture.provider';
import { SignatureGuard } from './signature.guard';
import { WebhookController } from './webhook.controller';

const phone = '123456789';
const secret = 'synthetic-test-secret';
const dto = { object: 'whatsapp_business_account', entry: [] };
const event = (sender = 'customer', id = 'inbound') => ({
  ...dto,
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: phone },
            messages: [{ from: sender, id, timestamp: '100', type: 'text' }],
          },
        },
      ],
    },
  ],
});
let moduleRef: TestingModule | undefined;
afterEach(async () => {
  await moduleRef?.close();
});
async function setup(
  enabled: unknown = true,
  restock = false,
  provider = true,
) {
  const config = new ConfigService({
    meta: { appSecret: secret, phoneNumberId: phone },
    humanDecisions: {
      customerInboundEnabled: enabled,
      restockEnabled: restock,
    },
  });
  const order: string[] = [];
  const query = jest
    .fn<Promise<{ rowCount: number; rows: unknown[] }>, [string, string[]]>()
    .mockImplementation((_sql, args) => {
      order.push('record');
      const [
        receivingPhoneNumberId,
        senderId,
        messageId,
        providerTimestampSeconds,
        observedAt,
      ] = args;
      return Promise.resolve({
        rowCount: 1,
        rows: [
          {
            senderId,
            receivingPhoneNumberId,
            messageId,
            providerTimestampSeconds,
            observedAt,
          },
        ],
      });
    });
  const dispatch = jest.fn().mockImplementation(() => {
    order.push('dispatch');
    return Promise.resolve();
  });
  const capture = jest.fn().mockImplementation(() => {
    order.push('restock');
    return Promise.resolve({ action: 'captured', event: dto });
  });
  const isOpsSender = jest.fn((id: string) => id === 'ops');
  const isKnown = jest.fn((id: string) => id === 'outbound');
  moduleRef = await Test.createTestingModule({
    controllers: [WebhookController],
    providers: [
      SignatureGuard,
      { provide: ConfigService, useValue: config },
      { provide: PG_POOL, useValue: { query } },
      { provide: HUMAN_HANDOFF_SERVICE_TOKEN, useValue: { isOpsSender } },
      { provide: RECENT_OUTBOUND, useValue: { isKnown } },
      { provide: WebhookDispatcherService, useValue: { dispatch } },
      { provide: RestockInboundCapture, useValue: { capture } },
      ...(provider ? [customerInboundCaptureProvider] : []),
    ],
  }).compile();
  const request = (input: unknown = event()) => {
    const rawBody = Buffer.from(JSON.stringify(input));
    const req = {
      rawBody,
      headers: {
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
      },
    };
    moduleRef!.get(SignatureGuard).canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext);
    return req as unknown as Request;
  };
  const handle = (req?: Request) =>
    moduleRef!.get(WebhookController).handleEvent(dto, req);
  return {
    query,
    dispatch,
    capture,
    isOpsSender,
    isKnown,
    order,
    request,
    handle,
  };
}

it.each([false, undefined, 'true'])(
  'disabled %p retains legacy dispatch without capture I/O',
  async (flag) => {
    const s = await setup(flag === undefined ? null : flag);
    expect(await s.handle()).toEqual({ received: true });
    expect(s.dispatch.mock.calls).toEqual([[dto]]);
    expect(s.query).not.toHaveBeenCalled();
    expect(s.isOpsSender).not.toHaveBeenCalled();
    expect(s.isKnown).not.toHaveBeenCalled();
  },
);
it('persists actual-request metadata before dispatch using the existing pool', async () => {
  const s = await setup();
  expect(await s.handle(s.request())).toEqual({ received: true });
  expect(s.query).toHaveBeenCalledTimes(1);
  expect(s.query.mock.calls[0][1]).toEqual([
    phone,
    'customer',
    'inbound',
    '100',
    expect.any(String),
  ]);
  expect(s.order).toEqual(['record', 'dispatch']);
  expect(s.dispatch.mock.calls).toEqual([[dto]]);
  expect(s.isOpsSender).toHaveBeenCalledWith('customer');
  expect(s.isKnown).toHaveBeenCalledWith('inbound');
});
it.each(['ops', 'outbound'])(
  'reuses %s exclusion without evidence writes',
  async (excluded) => {
    const s = await setup();
    expect(
      await s.handle(
        s.request(event(excluded === 'ops' ? 'ops' : 'customer', excluded)),
      ),
    ).toEqual({ received: true });
    expect(s.query).not.toHaveBeenCalled();
    expect(s.dispatch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  'missing provider',
  'missing request',
  'forgery',
  'hold',
  'SQL failure',
])('fails closed on %s without dispatch or retry', async (failure) => {
  const s = await setup(true, false, failure !== 'missing provider');
  let req: Request | undefined = s.request();
  if (failure === 'missing request') req = undefined;
  if (failure === 'forgery') req = { ...req } as Request;
  if (failure === 'hold')
    s.query.mockResolvedValue({ rowCount: 1, rows: [{}] });
  if (failure === 'SQL failure')
    s.query.mockRejectedValue(Error('private SQL failure'));
  await expect(s.handle(req)).rejects.toMatchObject({
    status: 500,
    message: 'Internal Server Error',
  });
  expect(s.dispatch).not.toHaveBeenCalled();
  expect(s.query).toHaveBeenCalledTimes(
    ['hold', 'SQL failure'].includes(failure) ? 1 : 0,
  );
});
it.each([false, true])(
  'preserves RESTOCK admission ordering with capture=%p',
  async (enabled) => {
    const s = await setup(enabled, true);
    expect(await s.handle(s.request())).toEqual({ received: true });
    expect(s.order).toEqual(
      enabled ? ['restock', 'record', 'dispatch'] : ['restock', 'dispatch'],
    );
    expect(s.capture).toHaveBeenCalledTimes(1);
    expect(s.dispatch.mock.calls).toEqual([[dto]]);
    expect(s.query).toHaveBeenCalledTimes(enabled ? 1 : 0);
  },
);
it('does not capture or dispatch after rejected RESTOCK admission', async () => {
  const s = await setup(true, true);
  s.capture.mockResolvedValue({ action: 'hold' });
  await expect(s.handle(s.request())).rejects.toMatchObject({ status: 500 });
  expect(s.capture).toHaveBeenCalledTimes(1);
  expect(s.query).not.toHaveBeenCalled();
  expect(s.dispatch).not.toHaveBeenCalled();
});
