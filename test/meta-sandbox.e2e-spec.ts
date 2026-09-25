import * as crypto from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../src/conversation/domain/conversation-store';
import { WHATSAPP_SENDER } from '../src/whatsapp/domain/whatsapp-sender.port';
import {
  MetaSandboxModule,
  SANDBOX_APP_SECRET,
  SANDBOX_REPLY,
  SANDBOX_VERIFY_TOKEN,
  type SandboxSender,
} from './demo/meta-sandbox.module';

/**
 * Offline contract for the isolated Meta-test-number demo module (M1).
 *
 * Proves the restricted route surface: only the real `GET/POST /webhook`
 * (WebhookController + SignatureGuard + dispatcher) is exposed, with every
 * outbound edge (LLM/agent, sender, receipt, human-handoff) faked in-memory.
 * No Meta, network, backend, DB, or production `AppModule` is touched.
 */
describe('Meta sandbox module (e2e, isolated webhook surface)', () => {
  let app: INestApplication<App>;
  let sender: SandboxSender;
  let conversationStore: ConversationStore;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [MetaSandboxModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    sender = app.get<SandboxSender>(WHATSAPP_SENDER);
    conversationStore = app.get<ConversationStore>(CONVERSATION_STORE);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  function sign(rawBody: string): string {
    return `sha256=${crypto
      .createHmac('sha256', SANDBOX_APP_SECRET)
      .update(rawBody)
      .digest('hex')}`;
  }

  function inboundText(rawBody: {
    messageId: string;
    from: string;
    text: string;
  }): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '123456789' },
                contacts: [{ wa_id: rawBody.from }],
                messages: [
                  {
                    id: rawBody.messageId,
                    from: rawBody.from,
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: rawBody.text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  }

  it('answers the GET verification challenge when the token matches', async () => {
    await request(app.getHttpServer())
      .get(
        `/webhook?hub.mode=subscribe&hub.verify_token=${SANDBOX_VERIFY_TOKEN}&hub.challenge=challenge-1`,
      )
      .expect(200)
      .expect('challenge-1');
  });

  it('rejects GET verification when the verify token mismatches (403)', async () => {
    await request(app.getHttpServer())
      .get(
        '/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=challenge-1',
      )
      .expect(403);
  });

  it('sends the canned reply through the fake sender for a signed inbound', async () => {
    const body = inboundText({
      messageId: 'wamid.sandbox.inbound.1',
      from: '5215550001111',
      text: 'hola sandbox',
    });

    await request(app.getHttpServer())
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(200)
      .expect({ received: true });

    expect(sender.sent).toEqual([{ to: '5215550001111', text: SANDBOX_REPLY }]);
    expect(await conversationStore.get('5215550001111')).toBeNull();
  });

  it('rejects POST /webhook without a signature header (401)', async () => {
    const body = inboundText({
      messageId: 'wamid.sandbox.inbound.2',
      from: '5215550002222',
      text: 'sin firma',
    });

    await request(app.getHttpServer())
      .post('/webhook')
      .set('content-type', 'application/json')
      .send(body)
      .expect(401);

    expect(sender.sent).toEqual([]);
  });

  it('rejects POST /webhook with a tampered signature (401)', async () => {
    const body = inboundText({
      messageId: 'wamid.sandbox.inbound.3',
      from: '5215550003333',
      text: 'firma mala',
    });

    await request(app.getHttpServer())
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign('tampered-body'))
      .send(body)
      .expect(401);

    expect(sender.sent).toEqual([]);
  });

  it.each(['/', '/media/receipts/anything', '/internal/receipt-media/metrics'])(
    'returns 404 for the non-webhook route %s',
    async (path) => {
      await request(app.getHttpServer()).get(path).expect(404);
    },
  );
});
