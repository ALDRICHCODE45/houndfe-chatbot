import * as crypto from 'crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WebhookDispatcherService } from '../application/webhook-dispatcher.service';
import { WebhookEventDto } from './dto/webhook-event.dto';
import { WebhookVerifyDto } from './dto/webhook-verify.dto';
import { SignatureGuard } from './signature.guard';
import { WebhookController } from './webhook.controller';

describe('WebhookController', () => {
  const verifyToken = 'verify-token';
  const appSecret = 'meta-app-secret';

  let controller: WebhookController;
  let dispatcher: jest.Mocked<Pick<WebhookDispatcherService, 'dispatch'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'getOrThrow'>>;

  beforeEach(() => {
    dispatcher = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          'meta.verifyToken': verifyToken,
          'meta.appSecret': appSecret,
        };

        return values[key];
      }),
    };

    controller = new WebhookController(
      configService as ConfigService,
      dispatcher as WebhookDispatcherService,
    );
  });

  it('returns the hub challenge when verify token and mode are valid', () => {
    const query: WebhookVerifyDto = {
      'hub.mode': 'subscribe',
      'hub.verify_token': verifyToken,
      'hub.challenge': 'challenge-token',
    };

    expect(controller.verify(query)).toBe('challenge-token');
  });

  it('throws 403 when the verify token is invalid', () => {
    const query: WebhookVerifyDto = {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge-token',
    };

    expect(() => controller.verify(query)).toThrow(
      'Invalid webhook verify token',
    );
  });

  it('dispatches inbound events and returns a fast acknowledgement', async () => {
    const payload: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [],
    };

    await expect(controller.handleEvent(payload)).resolves.toEqual({
      received: true,
    });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(payload);
  });

  describe('integration', () => {
    let app: INestApplication;
    let dispatchSpy: jest.MockedFunction<WebhookDispatcherService['dispatch']>;

    beforeEach(async () => {
      dispatchSpy = jest.fn().mockResolvedValue(undefined);

      const moduleRef = await Test.createTestingModule({
        controllers: [WebhookController],
        providers: [
          SignatureGuard,
          {
            provide: ConfigService,
            useValue: configService,
          },
          {
            provide: WebhookDispatcherService,
            useValue: {
              dispatch: dispatchSpy,
            },
          },
        ],
      }).compile();

      app = moduleRef.createNestApplication({ rawBody: true });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('returns the challenge via GET /webhook when the token is valid', async () => {
      await request(app.getHttpServer())
        .get(
          '/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=test',
        )
        .expect(200)
        .expect('test');
    });

    it('returns 403 via GET /webhook when the token is wrong', async () => {
      await request(app.getHttpServer())
        .get(
          '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test',
        )
        .expect(403);
    });

    it('accepts a signed POST /webhook event and acknowledges it', async () => {
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'wamid.abc',
                      from: '5215550001111',
                      timestamp: '1719000000',
                      type: 'text',
                      text: { body: 'hola' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(body).digest('hex')}`;

      await request(app.getHttpServer())
        .post('/webhook')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', signature)
        .send(body)
        .expect(200)
        .expect({ received: true });

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ object: 'whatsapp_business_account' }),
      );
    });
  });
});
