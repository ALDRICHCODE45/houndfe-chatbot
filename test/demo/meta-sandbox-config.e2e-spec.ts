import {
  SANDBOX_GRAPH_API_VERSION_DEFAULT,
  SandboxConfigError,
  SandboxOutboundError,
  createSandboxAllowlistSender,
  parseMetaSandboxConfig,
  toMetaSenderConfig,
  type SandboxEnv,
} from './meta-sandbox-config';
import {
  type OutboundText,
  type SendResult,
  type WhatsappSenderPort,
} from '../../src/whatsapp/domain/whatsapp-sender.port';

const BASE_ENV: Record<string, string | undefined> = {
  META_VERIFY_TOKEN: 'sandbox-verify-token',
  META_APP_SECRET: 'sandbox-app-secret',
  META_ACCESS_TOKEN: 'sandbox-access-token',
  META_PHONE_NUMBER_ID: '123456789',
  META_SANDBOX_RECIPIENT: '5215550001111',
};

const APPROVED_RECIPIENT = '525550001111';

class FakeInnerSender implements WhatsappSenderPort {
  readonly sent: OutboundText[] = [];

  async sendText(message: OutboundText): Promise<SendResult> {
    this.sent.push(message);
    return { providerMessageId: `wamid.sandbox.${this.sent.length}` };
  }
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function withEnv(overrides: Record<string, string | undefined>): SandboxEnv {
  return { ...BASE_ENV, ...overrides };
}

describe('parseMetaSandboxConfig (pure sandbox config)', () => {
  it('returns required values, canonical recipient and Graph origin', () => {
    const config = parseMetaSandboxConfig(BASE_ENV);

    expect(config.verifyToken).toBe('sandbox-verify-token');
    expect(config.appSecret).toBe('sandbox-app-secret');
    expect(config.accessToken).toBe('sandbox-access-token');
    expect(config.phoneNumberId).toBe('123456789');
    expect(config.approvedRecipient).toBe(APPROVED_RECIPIENT);
    expect(config.graphApiBaseUrl).toBe(
      `https://graph.facebook.com/${SANDBOX_GRAPH_API_VERSION_DEFAULT}`,
    );
  });

  it.each([
    'META_VERIFY_TOKEN',
    'META_APP_SECRET',
    'META_ACCESS_TOKEN',
    'META_PHONE_NUMBER_ID',
    'META_SANDBOX_RECIPIENT',
  ])('fails closed when %s is missing', (key) => {
    const error = captureError(() =>
      parseMetaSandboxConfig({ ...BASE_ENV, [key]: undefined }),
    );

    expect(error).toBeInstanceOf(SandboxConfigError);
    expect((error as SandboxConfigError).code).toBe('missing_required_value');
    expect((error as SandboxConfigError).field).toBe(key);
  });

  it('rejects a malformed phone number id', () => {
    const error = captureError(() =>
      parseMetaSandboxConfig(withEnv({ META_PHONE_NUMBER_ID: 'abc-123' })),
    );

    expect(error).toBeInstanceOf(SandboxConfigError);
    expect((error as SandboxConfigError).code).toBe('malformed_value');
    expect((error as SandboxConfigError).field).toBe('META_PHONE_NUMBER_ID');
  });

  it.each(['not-a-number', '+5215550001111', '521'])(
    'rejects a malformed recipient %s',
    (recipient) => {
      const error = captureError(() =>
        parseMetaSandboxConfig(withEnv({ META_SANDBOX_RECIPIENT: recipient })),
      );

      expect(error).toBeInstanceOf(SandboxConfigError);
      expect((error as SandboxConfigError).code).toBe('malformed_value');
      expect((error as SandboxConfigError).field).toBe(
        'META_SANDBOX_RECIPIENT',
      );
    },
  );

  it('accepts only the canonical Graph HTTPS origin (SSRF fence)', () => {
    const config = parseMetaSandboxConfig(
      withEnv({ META_GRAPH_API_BASE_URL: 'https://graph.facebook.com/v23.0' }),
    );
    expect(config.graphApiBaseUrl).toBe('https://graph.facebook.com/v23.0');

    const error = captureError(() =>
      parseMetaSandboxConfig(
        withEnv({ META_GRAPH_API_BASE_URL: 'https://evil.example.com/v1.0' }),
      ),
    );
    expect(error).toBeInstanceOf(SandboxConfigError);
    expect((error as SandboxConfigError).code).toBe('graph_origin_not_allowed');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
      'evil.example.com',
    );
  });

  it('builds the versioned origin from a validated version override', () => {
    const config = parseMetaSandboxConfig(
      withEnv({ META_GRAPH_API_VERSION: 'v99.0' }),
    );
    expect(config.graphApiBaseUrl).toBe('https://graph.facebook.com/v99.0');

    const error = captureError(() =>
      parseMetaSandboxConfig(withEnv({ META_GRAPH_API_VERSION: 'next' })),
    );
    expect(error).toBeInstanceOf(SandboxConfigError);
    expect((error as SandboxConfigError).code).toBe('malformed_value');
  });

  it('never echoes token, app secret, or full phone value on failure', () => {
    const phone = '5215550001111';
    const env = withEnv({ META_PHONE_NUMBER_ID: undefined });

    const error = captureError(() => parseMetaSandboxConfig(env));
    const rendered = `${String(error)} ${JSON.stringify(error)} ${(error as Error).message}`;

    expect(error).toBeInstanceOf(SandboxConfigError);
    expect(rendered).not.toContain('sandbox-verify-token');
    expect(rendered).not.toContain('sandbox-app-secret');
    expect(rendered).not.toContain('sandbox-access-token');
    expect(rendered).not.toContain(phone);
    expect(rendered).not.toContain(APPROVED_RECIPIENT);
    expect((error as SandboxConfigError).field).toBe('META_PHONE_NUMBER_ID');
  });

  it('projects only sender credentials and drops the app secret', () => {
    const projection = toMetaSenderConfig(parseMetaSandboxConfig(BASE_ENV));
    const rendered = JSON.stringify(projection);

    expect(projection.meta.accessToken).toBe('sandbox-access-token');
    expect(projection.meta.phoneNumberId).toBe('123456789');
    expect(projection.meta.graphApiBaseUrl).toBe(
      `https://graph.facebook.com/${SANDBOX_GRAPH_API_VERSION_DEFAULT}`,
    );
    expect(rendered).not.toContain('sandbox-app-secret');
    expect(rendered).not.toContain('sandbox-verify-token');
  });
});

describe('createSandboxAllowlistSender (recipient fence)', () => {
  let inner: FakeInnerSender;
  let sender: WhatsappSenderPort;

  beforeEach(() => {
    inner = new FakeInnerSender();
    sender = createSandboxAllowlistSender(
      inner,
      parseMetaSandboxConfig(BASE_ENV),
    );
  });

  it('forwards exactly one send to the canonical approved recipient', async () => {
    const result = await sender.sendText({
      to: '5215550001111',
      text: 'hola sandbox',
    });

    expect(result).toEqual({ providerMessageId: 'wamid.sandbox.1' });
    expect(inner.sent).toEqual([
      { to: APPROVED_RECIPIENT, text: 'hola sandbox' },
    ]);
  });

  it('refuses a wrong recipient with zero delegate calls', async () => {
    await expect(
      sender.sendText({ to: '5215550009999', text: 'hola' }),
    ).rejects.toBeInstanceOf(SandboxOutboundError);

    expect(inner.sent).toHaveLength(0);
  });

  it('refuses empty outbound text before delegating', async () => {
    const error = await sender
      .sendText({ to: '5215550001111', text: '   ' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxOutboundError);
    expect((error as SandboxOutboundError).code).toBe('empty_outbound_text');
    expect(inner.sent).toHaveLength(0);
  });

  it('never sends to an operator/ops phone from env', async () => {
    const opsFenced = createSandboxAllowlistSender(
      inner,
      parseMetaSandboxConfig(withEnv({ OPS_CHANNEL_PHONE: '5215550007777' })),
    );

    await expect(
      opsFenced.sendText({ to: '5215550007777', text: 'ops handoff' }),
    ).rejects.toBeInstanceOf(SandboxOutboundError);

    expect(inner.sent).toHaveLength(0);
  });

  it('does not infer send permission from env for other recipients', async () => {
    await expect(
      sender.sendText({ to: '5215550002222', text: 'hola' }),
    ).rejects.toBeInstanceOf(SandboxOutboundError);

    expect(inner.sent).toHaveLength(0);
  });
});
