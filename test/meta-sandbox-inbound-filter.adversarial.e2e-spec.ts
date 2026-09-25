import * as crypto from 'crypto';
import axios from 'axios';
import request from 'supertest';
import type { GenerateTextFn } from '../src/llm-agent/infrastructure/generate-text.provider';
import {
  type OutboundText,
  type SendResult,
  type WhatsappSenderPort,
} from '../src/whatsapp/domain/whatsapp-sender.port';
import { NO_TOOL_SANDBOX_SAFE_REPLIES } from './demo/no-tool-llm-sandbox';
import {
  createMetaSandboxApp,
  type MetaSandboxApp,
  type MetaSandboxAppOptions,
} from './demo/meta-sandbox-bootstrap';

// M2d adversarial contract (offline): the outbound pre-dispatch filter must
// classify the RAW signed payload, so unsupported/malformed elements, missing
// explicit `from`, and the `contacts[0].wa_id` fallback can never be silently
// authorized. Every case below runs a fake outbound transport plus a fake
// `generateText` seam; axios is a hard canary and no Meta/OpenAI request occurs.

const BASE_ENV: Record<string, string | undefined> = {
  META_VERIFY_TOKEN: 'sandbox-verify-token',
  META_APP_SECRET: 'sandbox-app-secret',
  META_ACCESS_TOKEN: 'sandbox-access-token',
  META_PHONE_NUMBER_ID: '123456789',
  META_SANDBOX_RECIPIENT: '5215550001111',
};
const LLM_ENV: Record<string, string | undefined> = {
  ...BASE_ENV,
  OPENAI_API_KEY: 'sk-test-not-a-real-secret',
  OPENAI_SANDBOX_MODEL: 'gpt-4.1-mini',
};
const APPROVED_SENDER = '5215550001111';
const WRONG_SENDER = '5215550009999';
const WRONG_SENDER_2 = '5215550008888';
const SAFE_REPLY = NO_TOOL_SANDBOX_SAFE_REPLIES[0];

function fakeGenerate(outcome: string = SAFE_REPLY) {
  const options: Array<Record<string, unknown>> = [];
  const mock = jest.fn(async (input: Record<string, unknown>) => {
    options.push(input);
    return { text: outcome };
  });
  return { generateText: mock as unknown as GenerateTextFn, mock, options };
}

function sign(rawBody: string): string {
  return `sha256=${crypto
    .createHmac('sha256', BASE_ENV.META_APP_SECRET as string)
    .update(rawBody)
    .digest('hex')}`;
}

function rawTextMessage(
  id: string,
  from: string,
  text: string,
): Record<string, unknown> {
  return {
    id,
    from,
    timestamp: '1719000000',
    type: 'text',
    text: { body: text },
  };
}

function rawInbound(value: Record<string, unknown>): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value }] }],
  });
}

/** Approved valid text plus one adversarial element for fail-closed tests. */
function adversarialBody(second: unknown, contacts?: unknown): string {
  return rawInbound({
    metadata: { phone_number_id: '123456789' },
    ...(contacts === undefined ? {} : { contacts }),
    messages: [
      rawTextMessage('wamid.m2d.adv.pk', APPROVED_SENDER, 'Hola'),
      second,
    ],
  });
}

/** Outbound fake transport: records the fenced send without calling Meta. */
class FakeTransport implements WhatsappSenderPort {
  readonly sent: OutboundText[] = [];
  async sendText(message: OutboundText): Promise<SendResult> {
    this.sent.push(message);
    return { providerMessageId: `wamid.fake.${this.sent.length}` };
  }
}

describe('meta sandbox inbound filter (e2e, adversarial, offline)', () => {
  const apps: MetaSandboxApp[] = [];
  let postSpy: jest.SpyInstance;

  beforeAll(() => {
    postSpy = jest.spyOn(axios, 'post').mockImplementation(() => {
      throw new Error('offline sandbox test: axios.post must never be invoked');
    });
  });

  afterAll(() => {
    postSpy.mockRestore();
  });

  afterEach(async () => {
    for (const sandbox of apps.splice(0)) {
      await sandbox.app.close();
    }
    postSpy.mockClear();
  });

  async function build(
    options: MetaSandboxAppOptions,
  ): Promise<MetaSandboxApp> {
    const sandbox = await createMetaSandboxApp(options);
    apps.push(sandbox);
    return sandbox;
  }

  async function post(sandbox: MetaSandboxApp, body: string): Promise<void> {
    await request(sandbox.app.getHttpServer())
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(200)
      .expect({ received: true });
  }

  async function postFailClosed(body: string): Promise<void> {
    const transport = new FakeTransport();
    const { generateText, mock } = fakeGenerate();
    const sandbox = await build({
      env: LLM_ENV,
      mode: 'outbound',
      llmMode: 'llm',
      generateText,
      outboundTransport: transport,
    });

    await request(sandbox.app.getHttpServer())
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(500);

    expect(mock).not.toHaveBeenCalled();
    expect(transport.sent).toHaveLength(0);
    expect(postSpy).not.toHaveBeenCalled();
  }

  it('fails closed on approved text mixed with an unsupported unapproved image', async () => {
    await postFailClosed(
      adversarialBody({
        id: 'wamid.m2d.adv.a.img',
        from: WRONG_SENDER,
        timestamp: '1719000000',
        type: 'image',
        image: { id: 'media-without-mime' },
      }),
    );
  });

  it('fails closed on an approved sender with an unsupported image element', async () => {
    await postFailClosed(
      rawInbound({
        metadata: { phone_number_id: '123456789' },
        messages: [
          rawTextMessage('wamid.m2d.adv.approved.pk', APPROVED_SENDER, 'Hola'),
          {
            id: 'wamid.m2d.adv.approved.img',
            from: APPROVED_SENDER,
            timestamp: '1719000000',
            type: 'image',
            image: { id: 'media-without-mime' },
          },
        ],
      }),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['an extra image payload', { image: { id: 'media-extra' } }],
    ['an extra document payload', { document: { id: 'media-extra' } }],
    ['an extra audio payload', { audio: { id: 'media-extra' } }],
    [
      'an extra text-level field',
      { text: { body: 'Hola', image: { id: 'media-extra' } } },
    ],
  ])(
    'fails closed on an approved text message carrying %s',
    async (_label, extra) => {
      await postFailClosed(
        rawInbound({
          metadata: { phone_number_id: '123456789' },
          messages: [
            {
              id: 'wamid.m2d.adv.extra',
              from: APPROVED_SENDER,
              timestamp: '1719000000',
              type: 'text',
              text: { body: 'Hola' },
              ...extra,
            },
          ],
        }),
      );
    },
  );

  it('fails closed on approved text mixed with a no-from message whose contact fallback is approved', async () => {
    await postFailClosed(
      adversarialBody(
        {
          id: 'wamid.m2d.adv.b.nofrom',
          timestamp: '1719000000',
          type: 'text',
          text: { body: 'Hola' },
        },
        [{ wa_id: APPROVED_SENDER }],
      ),
    );
  });

  it.each<[string, unknown]>([
    [
      'an invalid raw element',
      [rawTextMessage('wamid.m2d.adv.c.pk', APPROVED_SENDER, 'Hola'), 42],
    ],
    ['a non-array messages container', 'not-an-array'],
  ])(
    'fails closed on approved text mixed with %s',
    async (_label, messages) => {
      await postFailClosed(
        rawInbound({ metadata: { phone_number_id: '123456789' }, messages }),
      );
    },
  );

  it('acks a whole batch of unapproved senders, not just the first', async () => {
    const transport = new FakeTransport();
    const sandbox = await build({
      env: LLM_ENV,
      mode: 'outbound',
      outboundTransport: transport,
    });

    await post(
      sandbox,
      rawInbound({
        metadata: { phone_number_id: '123456789' },
        messages: [
          rawTextMessage('wamid.m2d.batch.wrong1', WRONG_SENDER, 'Hola'),
          rawTextMessage('wamid.m2d.batch.wrong2', WRONG_SENDER_2, 'Hola'),
        ],
      }),
    );

    expect(transport.sent).toHaveLength(0);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('stays inert for a signed callback that carries no inbound messages', async () => {
    const transport = new FakeTransport();
    const sandbox = await build({
      env: LLM_ENV,
      mode: 'outbound',
      outboundTransport: transport,
    });

    await post(
      sandbox,
      JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    );

    expect(transport.sent).toHaveLength(0);
    expect(postSpy).not.toHaveBeenCalled();
  });
});
