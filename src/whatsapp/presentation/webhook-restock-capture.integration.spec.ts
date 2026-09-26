import * as crypto from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { RestockInboundEvidencePort } from '../../human-decisions/infrastructure/postgres-restock-inbound-evidence.store';
import { RestockInboundCapture } from '../application/restock-inbound-capture';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import * as signatures from './signature.guard';
import { WebhookController } from './webhook.controller';

const secret = 'synthetic-local-test-key';
const observedAt = '2026-06-22T13:00:00.000Z';
const message = (id = 'wamid.first') => ({
  id,
  from: '5215555555555',
  timestamp: '1782129600',
  type: 'text',
  text: { body: '¿Hay café? ☕' },
});
const payload = (messages: unknown = [message()]) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: '123456789' },
            messages,
          },
        },
      ],
    },
  ],
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

// Isolated local HTTP only: no module factory, sender, database or Meta client.
describe('Webhook restock capture connection', () => {
  let app: INestApplication;
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const record = jest.fn<
    ReturnType<RestockInboundEvidencePort['record']>,
    Parameters<RestockInboundEvidencePort['record']>
  >();
  let capture: RestockInboundCapture;
  let captureSpy: jest.SpyInstance;

  async function setup(
    options: {
      flag?: unknown;
      missingProvider?: boolean;
      fakeGuard?: boolean;
      mutate?: boolean;
      captureEnabled?: boolean;
    } = {},
  ) {
    const flag = 'flag' in options ? options.flag : true;
    const config = new ConfigService({
      meta: { appSecret: secret },
      humanDecisions: { restockEnabled: flag },
    });
    capture = new RestockInboundCapture(
      options.captureEnabled ?? true,
      '123456789',
      { record },
      () => false,
      () => false,
    );
    captureSpy = jest.spyOn(capture, 'capture');
    const builder = Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        signatures.SignatureGuard,
        { provide: ConfigService, useValue: config },
        { provide: WebhookDispatcherService, useValue: { dispatch } },
        ...(options.missingProvider
          ? []
          : [{ provide: RestockInboundCapture, useValue: capture }]),
      ],
    });
    if (options.fakeGuard)
      builder
        .overrideGuard(signatures.SignatureGuard)
        .useValue({ canActivate: () => true });
    const module = await builder.compile();
    app = module.createNestApplication({ rawBody: true, logger: false });
    app.useGlobalInterceptors({
      intercept(context, next) {
        const req = context.switchToHttp().getRequest<{
          body: unknown;
          rawBody: Buffer;
          snapshot?: unknown;
        }>();
        req.snapshot = {
          rawBodyBase64: Buffer.from(JSON.stringify(payload())).toString(
            'base64',
          ),
          observedAt,
        };
        if (options.mutate) {
          req.body = { forged: true };
          req.rawBody.fill(32);
        }
        return next.handle();
      },
    });
    await app.init();
  }
  function post(body: unknown = payload(), validSignature = true) {
    const text = JSON.stringify(body);
    const digest = crypto
      .createHmac('sha256', secret)
      .update(text)
      .digest('hex');
    return request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/webhook')
      .set('content-type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${validSignature ? digest : '0'.repeat(64)}`,
      )
      .send(text);
  }
  async function fails(body: unknown = payload()) {
    const response = await post(body).expect(500);
    expect(response.body).toEqual({
      statusCode: 500,
      message: expect.stringMatching(
        /^Internal [Ss]erver [Ee]rror$/,
      ) as unknown,
    });
    expect(dispatch).not.toHaveBeenCalled();
  }
  beforeEach(() => {
    dispatch.mockClear();
    record.mockReset().mockImplementation(async (evidence) => ({
      action: 'recorded',
      evidence,
    }));
    // Only Date is controlled; real socket timers remain live.
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(observedAt);
  });
  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it('awaits durable record before dispatch and HTTP acknowledgement', async () => {
    await setup();
    const entered = deferred();
    const release = deferred();
    record.mockImplementationOnce(async (evidence) => {
      entered.resolve();
      await release.promise;
      return { action: 'recorded', evidence };
    });
    let settled = false;
    const pending = post()
      .expect(200)
      .expect({ received: true })
      .then(() => {
        settled = true;
      });
    // Race permits a useful RED when the controller bypasses capture entirely.
    try {
      await Promise.race([entered.promise, pending]);
      expect(record).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await pending;
    }
    expect(dispatch).toHaveBeenCalledWith(payload());
  });

  it('uses guard-owned bytes despite post-guard body and rawBuffer mutation', async () => {
    await setup({ mutate: true });
    await post().expect(200);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'wamid.first' }),
    );
    expect(dispatch).toHaveBeenCalledWith(payload());
    expect(captureSpy).toHaveBeenCalledWith({
      rawBodyBase64: Buffer.from(JSON.stringify(payload())).toString('base64'),
      observedAt,
    });
  });

  it('captures status-only without evidence writes and dispatches safely', async () => {
    await setup();
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { statuses: [] } }] }],
    };
    await post(body).expect(200);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(body);
  });

  it('rejects an invalid signature before all effects', async () => {
    await setup();
    await post(payload(), false).expect(401);
    expect(captureSpy).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { missingProvider: true },
    { fakeGuard: true },
    { captureEnabled: false },
  ])('fails closed for unavailable authority/capture: %p', async (options) => {
    await setup(options);
    await fails();
    expect(record).not.toHaveBeenCalled();
  });

  it('fails closed for a null private snapshot', async () => {
    await setup();
    jest.spyOn(signatures, 'readVerifiedWebhookSnapshot').mockReturnValue(null);
    await fails();
    expect(record).not.toHaveBeenCalled();
  });

  it('fails closed when persistence holds', async () => {
    await setup();
    record.mockResolvedValueOnce({ action: 'hold' });
    await fails();
  });

  it('propagates storage rejection as 500 without dispatch', async () => {
    await setup();
    record.mockRejectedValueOnce(new Error('synthetic storage failure'));
    await fails();
  });

  it('validates the complete batch before any write', async () => {
    await setup();
    await fails(
      payload([message(), { ...message('wamid.second'), timestamp: 'bad' }]),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it.each([false, undefined, 'true'])(
    'bypasses capture for non-strict flag %p',
    async (flag) => {
      await setup({ flag, mutate: true });
      const getter = jest.spyOn(signatures, 'readVerifiedWebhookSnapshot');
      await post({ invalidForCapture: true })
        .expect(200)
        .expect({ received: true });
      expect(captureSpy).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith({ forged: true });
    },
  );
});
