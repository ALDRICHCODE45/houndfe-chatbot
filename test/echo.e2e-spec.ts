import * as crypto from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AppModule as AppModuleStatic } from '../src/app.module';
import type { ConversationStore } from '../src/conversation/domain/conversation-store';
import type { CONVERSATION_STORE as CONVERSATION_STORE_MODULE } from '../src/conversation/domain/conversation-store';
import type { WHATSAPP_SENDER as WHATSAPP_SENDER_MODULE } from '../src/whatsapp/domain/whatsapp-sender.port';
import { InMemoryConversationStore } from '../src/conversation/infrastructure/in-memory-conversation.store';
import { InMemoryWebhookDedupStore } from '../src/whatsapp/infrastructure/in-memory-webhook-dedup.store';
import type { WEBHOOK_DEDUP as WEBHOOK_DEDUP_MODULE } from '../src/whatsapp/domain/webhook-dedup.store';
import type { LLM_AGENT as LLM_AGENT_MODULE } from '../src/llm-agent/domain/llm-agent.port';
import type { LlmAgentPort } from '../src/llm-agent/domain/llm-agent.port';

describe('Webhook agent flow (e2e)', () => {
  const verifyToken = 'verify-token';
  const appSecret = 'meta-app-secret';

  let app: INestApplication<App>;
  let conversationStore: ConversationStore;
  let sender: {
    sendText: jest.Mock<
      Promise<{ providerMessageId: string }>,
      [{ to: string; text: string }]
    >;
  };
  let conversationStoreToken: symbol;
  let whatsappSenderToken: symbol;
  let webhookDedupToken: symbol;
  let llmAgentToken: symbol;
  let llmAgent: LlmAgentPort;

  beforeEach(async () => {
    process.env.META_VERIFY_TOKEN = verifyToken;
    process.env.META_APP_SECRET = appSecret;
    process.env.META_ACCESS_TOKEN = 'meta-access-token';
    process.env.META_PHONE_NUMBER_ID = '123456789';
    process.env.META_GRAPH_API_BASE_URL = 'https://graph.facebook.com/v23.0';
    process.env.CHATBOT_API_BASE_URL = 'https://backend.example.com';
    process.env.SERVICE_KEY = 'svc_test_key';
    process.env.CHATBOT_API_BRANCH_ID = 'branch-123';
    process.env.CHATBOT_API_CASHIER_USER_ID =
      '00000000-0000-4000-8000-000000000001';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.LLM_MODEL = 'test-model';
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    process.env.OPS_CHANNEL_PHONE = '5215500000000';

    // NOTE: dynamic require() below is intentional. NestJS's @nestjs/config runs
    // env validation eagerly inside ConfigModule.forRoot(), so AppModule must be
    // loaded AFTER process.env is populated in this beforeEach. Static ES
    // imports would hoist module evaluation above the env assignment.

    const { AppModule } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/app.module') as typeof AppModuleStatic;
    ({ CONVERSATION_STORE: conversationStoreToken } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/conversation/domain/conversation-store') as typeof CONVERSATION_STORE_MODULE);
    ({ WHATSAPP_SENDER: whatsappSenderToken } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/whatsapp/domain/whatsapp-sender.port') as typeof WHATSAPP_SENDER_MODULE);
    ({ WEBHOOK_DEDUP: webhookDedupToken } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/whatsapp/domain/webhook-dedup.store') as typeof WEBHOOK_DEDUP_MODULE);
    ({ LLM_AGENT: llmAgentToken } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/llm-agent/domain/llm-agent.port') as typeof LLM_AGENT_MODULE);

    const mockedSendText = jest
      .fn<
        Promise<{ providerMessageId: string }>,
        [{ to: string; text: string }]
      >()
      .mockResolvedValue({ providerMessageId: 'wamid.reply' });
    sender = { sendText: mockedSendText };

    llmAgent = {
      run: jest.fn().mockResolvedValue({
        reply: 'Hola, ¿en qué puedo ayudarte?',
        messages: [
          { role: 'user', content: 'hola mundo' },
          {
            role: 'assistant',
            content: 'Hola, ¿en qué puedo ayudarte?',
          },
        ],
        usage: { promptTokens: 5, completionTokens: 8 },
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(whatsappSenderToken)
      .useValue(sender)
      .overrideProvider(conversationStoreToken)
      .useValue(new InMemoryConversationStore())
      .overrideProvider(webhookDedupToken)
      .useValue(new InMemoryWebhookDedupStore())
      .overrideProvider(llmAgentToken)
      .useValue(llmAgent)
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );
    await app.init();

    conversationStore = app.get<ConversationStore>(conversationStoreToken, {
      strict: false,
    });
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
    delete process.env.CHATBOT_API_CASHIER_USER_ID;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_MODEL;
    delete process.env.DATABASE_URL;
  });

  it('keeps GET /webhook verification working', async () => {
    await request(app.getHttpServer())
      .get(
        '/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-1',
      )
      .expect(200)
      .expect('challenge-1');
  });

  it('accepts a signed inbound text event, acknowledges it, and sends the agent reply', async () => {
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
      text: 'Hola, ¿en qué puedo ayudarte?',
    });

    const state = await conversationStore.get('5215550001111');
    expect(state?.senderId).toBe('5215550001111');
    expect(state?.data.messages).toEqual([
      { role: 'user', content: 'hola mundo' },
      {
        role: 'assistant',
        content: 'Hola, ¿en qué puedo ayudarte?',
      },
    ]);
  });
});
