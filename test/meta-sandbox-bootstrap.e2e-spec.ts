import * as crypto from 'crypto';
import { HttpService } from '@nestjs/axios';
import request from 'supertest';
import {
  type OutboundText,
  type SendResult,
  type WhatsappSenderPort,
} from '../src/whatsapp/domain/whatsapp-sender.port';
import {
  SandboxConfigError,
  SandboxOutboundError,
} from './demo/meta-sandbox-config';
import { SANDBOX_REPLY, SandboxSender } from './demo/meta-sandbox.module';
import {
  SANDBOX_BIND_HOST,
  createMetaSandboxApp,
  resolveBindHost,
  resolveSandboxMode,
  type MetaSandboxApp,
  type MetaSandboxAppOptions,
} from './demo/meta-sandbox-bootstrap';

// M2a2 offline contract: no Meta unless the explicit CLI opt-in is present, all
// outbound fenced through M2a1, and bad config fails before any bind. Every
// send below goes through a fake transport.

const BASE_ENV: Record<string, string | undefined> = {
  META_VERIFY_TOKEN: 'sandbox-verify-token',
  META_APP_SECRET: 'sandbox-app-secret',
  META_ACCESS_TOKEN: 'sandbox-access-token',
  META_PHONE_NUMBER_ID: '123456789',
  META_SANDBOX_RECIPIENT: '5215550001111',
};
const APPROVED_TO = '525550001111';

class FakeTransport implements WhatsappSenderPort {
  readonly sent: OutboundText[] = [];
  async sendText(message: OutboundText): Promise<SendResult> {
    this.sent.push(message);
    return { providerMessageId: `wamid.fake.${this.sent.length}` };
  }
}

function sign(rawBody: string): string {
  return `sha256=${crypto
    .createHmac('sha256', BASE_ENV.META_APP_SECRET as string)
    .update(rawBody)
    .digest('hex')}`;
}

function inboundBody(sender: string, text: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '123456789' },
              messages: [
                {
                  id: `wamid.in.${sender}`,
                  from: sender,
                  timestamp: '1719000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe('meta sandbox bootstrap (e2e, offline)', () => {
  let apps: MetaSandboxApp[] = [];

  afterEach(async () => {
    for (const sandbox of apps) {
      await sandbox.app.close();
    }
    apps = [];
  });

  async function build(
    options: MetaSandboxAppOptions,
  ): Promise<MetaSandboxApp> {
    const sandbox = await createMetaSandboxApp(options);
    apps.push(sandbox);
    return sandbox;
  }

  it('requires the explicit CLI flag and a loopback bind', () => {
    expect(resolveSandboxMode([])).toBe('local');
    expect(resolveSandboxMode(['--local'])).toBe('local');
    expect(resolveSandboxMode(['--outbound'])).toBe('outbound');
    expect(resolveBindHost()).toBe(SANDBOX_BIND_HOST);
    expect(resolveBindHost('localhost')).toBe(SANDBOX_BIND_HOST);
    expect(() => resolveBindHost('0.0.0.0')).toThrow(/loopback/);
  });

  it('fails closed on malformed config before any bind', async () => {
    const error = await createMetaSandboxApp({
      env: { ...BASE_ENV, META_SANDBOX_RECIPIENT: 'nope' },
      mode: 'outbound',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxConfigError);
    expect((error as SandboxConfigError).code).toBe('malformed_value');
    expect((error as SandboxConfigError).field).toBe('META_SANDBOX_RECIPIENT');
  });

  it('binds only the loopback host on listen', async () => {
    const sandbox = await build({ env: BASE_ENV });
    const url = await sandbox.listen({ port: 0 });

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Number(url.split(':')[2])).toBeGreaterThan(0);
  });

  it('default local mode uses the fake sender even when env and transport exist', async () => {
    const transport = new FakeTransport();
    const sandbox = await build({
      env: BASE_ENV,
      outboundTransport: transport,
    });

    expect(sandbox.mode).toBe('local');
    expect(sandbox.sender).toBeInstanceOf(SandboxSender);
    expect(() => sandbox.app.get(HttpService)).toThrow();

    const body = inboundBody('5215550001111', 'hola');
    await request(sandbox.app.getHttpServer())
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(200)
      .expect({ received: true });

    expect((sandbox.sender as SandboxSender).sent).toEqual([
      { to: '5215550001111', text: SANDBOX_REPLY },
    ]);
    expect(transport.sent).toHaveLength(0);
  });

  it('exposes only the signed webhook routes', async () => {
    const sandbox = await build({ env: BASE_ENV });
    const server = sandbox.app.getHttpServer();

    await request(server)
      .get(
        `/webhook?hub.mode=subscribe&hub.verify_token=${BASE_ENV.META_VERIFY_TOKEN}&hub.challenge=c1`,
      )
      .expect(200)
      .expect('c1');
    await request(server)
      .get(
        '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=c1',
      )
      .expect(403);

    const body = inboundBody('5215550001111', 'hola');
    await request(server)
      .post('/webhook')
      .set('content-type', 'application/json')
      .send(body)
      .expect(401);
    expect((sandbox.sender as SandboxSender).sent).toHaveLength(0);

    for (const path of [
      '/',
      '/media/receipts/x',
      '/internal/receipt-media/metrics',
    ]) {
      await request(server).get(path).expect(404);
    }
  });

  it('explicit outbound mode fences the fake transport to the approved recipient', async () => {
    const transport = new FakeTransport();
    const sandbox = await build({
      env: BASE_ENV,
      mode: 'outbound',
      outboundTransport: transport,
    });

    expect(sandbox.mode).toBe('outbound');
    await expect(
      sandbox.sender.sendText({ to: '5215550009999', text: 'hola' }),
    ).rejects.toBeInstanceOf(SandboxOutboundError);
    expect(transport.sent).toHaveLength(0);

    const approved = inboundBody('5215550001111', 'hola');
    await request(sandbox.app.getHttpServer())
      .post('/webhook')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(approved))
      .send(approved)
      .expect(200);

    expect(transport.sent).toEqual([{ to: APPROVED_TO, text: SANDBOX_REPLY }]);
  });
});
