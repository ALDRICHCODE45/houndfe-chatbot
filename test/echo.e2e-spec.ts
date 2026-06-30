import * as crypto from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { ConversationStore } from '../src/conversation/domain/conversation-store';

describe('Webhook echo flow (e2e)', () => {
  const verifyToken = 'verify-token';
  const appSecret = 'meta-app-secret';

  let app: INestApplication<App>;
  let conversationStore: ConversationStore;
  let sender: { sendText: jest.Mock<Promise<{ providerMessageId: string }>, [{ to: string; text: string }]> };
  let conversationStoreToken: symbol;
  let whatsappSenderToken: symbol;

  beforeEach(async () => {
    process.env.META_VERIFY_TOKEN = verifyToken;
    process.env.META_APP_SECRET = appSecret;
    process.env.META_ACCESS_TOKEN = 'meta-access-token';
    process.env.META_PHONE_NUMBER_ID = '123456789';
    process.env.META_GRAPH_API_BASE_URL = 'https://graph.facebook.com/v23.0';
    process.env.CHATBOT_API_BASE_URL = 'https://backend.example.com';
    process.env.SERVICE_KEY = 'svc_test_key';
    process.env.CHATBOT_API_BRANCH_ID = 'branch-123';

    jest.isolateModules(() => undefined);
    const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
    ({ CONVERSATION_STORE: conversationStoreToken } = require('../src/conversation/domain/conversation-store') as typeof import('../src/conversation/domain/conversation-store'));
    ({ WHATSAPP_SENDER: whatsappSenderToken } = require('../src/whatsapp/domain/whatsapp-sender.port') as typeof import('../src/whatsapp/domain/whatsapp-sender.port'));

    sender = {
      sendText: jest.fn().mockResolvedValue({ providerMessageId: 'wamid.reply' }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(whatsappSenderToken)
      .useValue(sender)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    await app.init();

    conversationStore = app.get<ConversationStore>(conversationStoreToken, { strict: false });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    jest.resetModules();
    delete process.env.META_VERIFY_TOKEN;
    delete process.env.META_APP_SECRET;
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_PHONE_NUMBER_ID;
    delete process.env.META_GRAPH_API_BASE_URL;
    delete process.env.CHATBOT_API_BASE_URL;
    delete process.env.SERVICE_KEY;
    delete process.env.CHATBOT_API_BRANCH_ID;
  });

  it('keeps GET /webhook verification working', async () => {
    await request(app.getHttpServer())
      .get('/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-1')
      .expect(200)
      .expect('challenge-1');
  });

  it('accepts a signed inbound text event, acknowledges it, and sends an echo reply', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '5215550001111' }],
                messages: [
                  {
                    id: 'wamid.inbound',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'hola mundo' },
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

    expect(sender.sendText).toHaveBeenCalledWith({
      to: '5215550001111',
      text: 'Echo: hola mundo',
    });

    await expect(conversationStore.get('5215550001111')).resolves.toEqual({
      senderId: '5215550001111',
      lastMessageAt: '2024-06-21T20:00:00.000Z',
      data: {
        lastInboundMessageId: 'wamid.inbound',
        lastInboundText: 'hola mundo',
      },
    });
  });
});
