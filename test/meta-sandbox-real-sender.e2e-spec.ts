import axios from 'axios';
import { HttpService } from '@nestjs/axios';
import request from 'supertest';
import {
  SandboxAllowlistSender,
  SandboxOutboundError,
  parseMetaSandboxConfig,
} from './demo/meta-sandbox-config';
import {
  createMetaSandboxApp,
  type MetaSandboxApp,
} from './demo/meta-sandbox-bootstrap';

// M2a2 hardening (offline): covers the REAL sender branch of
// `createMetaSandboxApp` — `mode: 'outbound'` with NO `outboundTransport`,
// where the app instantiates `HttpService` and wraps a real
// `MetaWhatsappSender` behind the M2a1 allowlist fence.
//
// Safety invariant: axios is neutralized as a hard canary. A send with an
// unapproved recipient, or with empty text, must reject inside the fence and
// never reach `HttpService`/axios. The approved recipient is deliberately
// never passed to `sendText`, so no Meta request can occur. No real env,
// tunnel, DB, or LLM is involved.

const SANDBOX_ENV: Record<string, string | undefined> = {
  META_VERIFY_TOKEN: 'sandbox-verify-token',
  META_APP_SECRET: 'sandbox-app-secret',
  META_ACCESS_TOKEN: 'sandbox-access-token',
  META_PHONE_NUMBER_ID: '123456789',
  META_SANDBOX_RECIPIENT: '5215550001111',
};
// Canonical approved recipient after the M2a1 Mexico trunk normalization.
const APPROVED_TO = '525550001111';
const WRONG_TO = '5215550009999';

describe('meta sandbox real-sender branch (e2e, offline)', () => {
  const apps: MetaSandboxApp[] = [];
  let postSpy: jest.SpyInstance;

  beforeAll(() => {
    // Hard canary: any accidental outbound call throws instead of hitting Meta.
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

  async function buildOutbound(): Promise<MetaSandboxApp> {
    const sandbox = await createMetaSandboxApp({
      env: SANDBOX_ENV,
      mode: 'outbound',
    });
    apps.push(sandbox);
    return sandbox;
  }

  it('constructs the real sender branch with a directly-built HttpService', async () => {
    const sandbox = await buildOutbound();

    expect(sandbox.mode).toBe('outbound');
    expect(sandbox.sender).toBeInstanceOf(SandboxAllowlistSender);
    // Documented approved target: deliberately never passed to `sendText`.
    expect(parseMetaSandboxConfig(SANDBOX_ENV).approvedRecipient).toBe(
      APPROVED_TO,
    );
    // The outbound factory builds its own HttpService, so it is not exposed via
    // DI on this test-only profile (no HttpModule import).
    expect(() => sandbox.app.get(HttpService)).toThrow();
    // That directly-built HttpService defaults to the shared axios instance,
    // which the `axios.post` canary above neutralizes.
    expect(new HttpService().axiosRef).toBe(axios);

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('rejects a wrong recipient before any HttpService/axios request', async () => {
    const sandbox = await buildOutbound();

    const rejection = sandbox.sender.sendText({ to: WRONG_TO, text: 'hola' });
    await expect(rejection).rejects.toBeInstanceOf(SandboxOutboundError);
    await expect(rejection).rejects.toMatchObject({
      code: 'recipient_not_allowed',
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('rejects empty text before any HttpService/axios request', async () => {
    const sandbox = await buildOutbound();

    const rejection = sandbox.sender.sendText({ to: WRONG_TO, text: '   ' });
    await expect(rejection).rejects.toBeInstanceOf(SandboxOutboundError);
    await expect(rejection).rejects.toMatchObject({
      code: 'empty_outbound_text',
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('exposes only the signed webhook routes', async () => {
    const sandbox = await buildOutbound();
    const server = sandbox.app.getHttpServer();

    await request(server)
      .get(
        '/webhook?hub.mode=subscribe&hub.verify_token=sandbox-verify-token&hub.challenge=c1',
      )
      .expect(200)
      .expect('c1');
    await request(server)
      .get(
        '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=c1',
      )
      .expect(403);

    // Unsigned POST only: a valid signed inbound would trigger a real send.
    await request(server)
      .post('/webhook')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }))
      .expect(401);

    for (const path of [
      '/',
      '/media/receipts/x',
      '/internal/receipt-media/metrics',
    ]) {
      await request(server).get(path).expect(404);
    }

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('closes the app and releases the loopback listener', async () => {
    const sandbox = await createMetaSandboxApp({
      env: SANDBOX_ENV,
      mode: 'outbound',
    });

    const url = await sandbox.listen({ port: 0 });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const server = sandbox.app.getHttpServer();
    expect(server.listening).toBe(true);

    await sandbox.app.close();
    expect(server.listening).toBe(false);
    expect(postSpy).not.toHaveBeenCalled();
  });
});
