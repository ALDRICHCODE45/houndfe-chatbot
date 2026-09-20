import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { InboundMessage } from '../domain/inbound-message';
import {
  OutboundText,
  UnsupportedOutboundError,
  WHATSAPP_SENDER,
} from '../domain/whatsapp-sender.port';
import {
  MetaWhatsappSender,
  normalizeSandboxRecipient,
  WhatsappSendError,
} from './meta-whatsapp.sender';

describe('MetaWhatsappSender', () => {
  let httpService: { post: jest.Mock };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };
  let sender: MetaWhatsappSender;
  let sandboxRecipientNormalizationEnabled: boolean;

  beforeEach(() => {
    sandboxRecipientNormalizationEnabled = false;
    httpService = {
      post: jest.fn(),
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'meta.graphApiBaseUrl') {
          return 'https://graph.facebook.com/v23.0';
        }

        if (key === 'meta.sandboxRecipientNormalizationEnabled') {
          return sandboxRecipientNormalizationEnabled;
        }

        return undefined;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          'meta.accessToken': 'meta-access-token',
          'meta.phoneNumberId': '1234567890',
          'meta.graphApiBaseUrl': 'https://graph.facebook.com/v23.0',
        };

        return values[key];
      }),
    };

    sender = new MetaWhatsappSender(
      httpService as unknown as HttpService,
      configService as unknown as ConfigService,
    );
  });

  it('exposes a symbol token and keeps inbound envelopes normalized for downstream phases', () => {
    const tokenType = typeof WHATSAPP_SENDER;
    const inbound: InboundMessage = {
      senderId: '5215550001111',
      text: 'hola',
      messageId: 'wamid.abc',
      timestamp: '1719000000',
    };

    expect(tokenType).toBe('symbol');
    expect(inbound.senderId).toBe('5215550001111');
    expect(inbound.text).toBe('hola');
  });

  it('sends one Graph API text request preserving the exact wa_id by default and returns the provider message id', async () => {
    httpService.post.mockReturnValue(
      of({
        data: {
          messages: [{ id: 'wamid.HBgLNDU2' }],
        },
      }),
    );

    const outbound: OutboundText = {
      to: '5215550001111',
      text: 'Echo: hola',
    };

    await expect(sender.sendText(outbound)).resolves.toEqual({
      providerMessageId: 'wamid.HBgLNDU2',
    });

    expect(httpService.post).toHaveBeenCalledTimes(1);
    expect(httpService.post).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/1234567890/messages',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5215550001111',
        type: 'text',
        text: {
          body: 'Echo: hola',
        },
      },
      {
        headers: {
          Authorization: 'Bearer meta-access-token',
        },
      },
    );
  });

  it('rewrites the trunk-1 recipient only when normalization is enabled', async () => {
    sandboxRecipientNormalizationEnabled = true;
    httpService.post.mockReturnValue(of({ data: { messages: [{ id: 'w' }] } }));
    await sender.sendText({ to: '5215550001111', text: 'Echo: hola' });
    expect(httpService.post).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ to: '525550001111' }),
      expect.anything(),
    );
  });

  it('rejects non-text payloads as unsupported', async () => {
    const outbound = {
      to: '5215550001111',
      image: { id: 'media-123' },
    } as unknown as OutboundText;

    await expect(sender.sendText(outbound)).rejects.toThrow(
      UnsupportedOutboundError,
    );
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('throws a sanitized typed error without leaking Authorization when Graph API rejects', async () => {
    const token = 'meta-access-token';
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 400',
      config: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      response: {
        status: 400,
        data: {
          error: {
            code: 100,
            message: 'Invalid recipient',
          },
        },
      },
    };

    httpService.post.mockReturnValue(throwError(() => axiosError));

    let thrown: unknown;
    try {
      await sender.sendText({ to: '5215550001111', text: 'hola' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WhatsappSendError);
    expect((thrown as WhatsappSendError).status).toBe(400);
    expect(JSON.stringify(thrown)).not.toContain(token);
    expect(JSON.stringify(thrown)).not.toContain('Authorization');
  });
});

describe('normalizeSandboxRecipient (explicit opt-in sandbox compatibility mode)', () => {
  it('preserves 521XXXXXXXXXX when disabled and strips the trunk when enabled', () => {
    const to = '5215585876245';
    expect(normalizeSandboxRecipient(to, false)).toBe(to);
    expect(normalizeSandboxRecipient(to, true)).toBe('525585876245');
  });

  it.each([
    ['non-Mexican', '15550001111'],
    ['already stripped', '525585876245'],
    ['truncated 521', '52155858762'],
    ['malformed', 'not-a-number'],
  ])('leaves %s unchanged in both modes', (_label, value) => {
    expect(normalizeSandboxRecipient(value, false)).toBe(value);
    expect(normalizeSandboxRecipient(value, true)).toBe(value);
  });
});
