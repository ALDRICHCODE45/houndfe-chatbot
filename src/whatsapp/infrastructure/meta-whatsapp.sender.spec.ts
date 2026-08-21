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
  let httpService: jest.Mocked<Pick<HttpService, 'post'>>;
  let configService: jest.Mocked<Pick<ConfigService, 'get' | 'getOrThrow'>>;
  let sender: MetaWhatsappSender;

  beforeEach(() => {
    httpService = {
      post: jest.fn(),
    };

    configService = {
      get: jest.fn((key: string) => {
        if (key === 'meta.graphApiBaseUrl') {
          return 'https://graph.facebook.com/v23.0';
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
      httpService as HttpService,
      configService as ConfigService,
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

  it('sends one Graph API text request and returns the provider message id', async () => {
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
        to: '525550001111',
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

describe('normalizeSandboxRecipient (TEMPORARY sandbox workaround)', () => {
  it('strips the Mexican national trunk 1 from a 521XXXXXXXXXX number', () => {
    expect(normalizeSandboxRecipient('5215585876245')).toBe('525585876245');
  });

  it('leaves non-Mexican numbers unchanged', () => {
    expect(normalizeSandboxRecipient('15550001111')).toBe('15550001111');
    expect(normalizeSandboxRecipient('44235550001111')).toBe('44235550001111');
  });

  it('leaves Mexican numbers without the trunk 1 unchanged', () => {
    expect(normalizeSandboxRecipient('525585876245')).toBe('525585876245');
  });

  it('leaves malformed numbers unchanged', () => {
    expect(normalizeSandboxRecipient('52155858762')).toBe('52155858762');
    expect(normalizeSandboxRecipient('not-a-number')).toBe('not-a-number');
  });
});
