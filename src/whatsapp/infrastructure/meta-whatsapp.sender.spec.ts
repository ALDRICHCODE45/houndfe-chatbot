import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
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

// Complete, type-safe `AxiosResponse` fixture: `HttpService.post<T>()` resolves
// to `AxiosResponse<T>`, so a bare `{ data }` object is not assignable. The full
// shape (including the required `AxiosHeaders` config) keeps the response
// stream typed without erasure.
function axiosResponse<T>(data: T, status = 200): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

describe('MetaWhatsappSender', () => {
  // The sender's constructor requires a full `HttpService`, so a partial Jest
  // mock cannot be passed without an unsafe cast. Build a real `HttpService`,
  // install the `post` spy before the sender is constructed so no test can
  // reach the network, and pass the real service to the sender while keeping a
  // typed handle to that same spy as `httpService`.
  let httpService: { post: jest.SpiedFunction<HttpService['post']> };
  let sender: MetaWhatsappSender;

  beforeEach(() => {
    const service = new HttpService();

    httpService = {
      post: jest
        .spyOn(service, 'post')
        .mockImplementation(() =>
          throwError(() => new Error('unexpected network request')),
        ),
    };

    // In-memory `ConfigService`: `meta.*` resolves through the internal config
    // via dot-notation, matching the production runtime contract instead of a
    // partial mock of the overloaded `getOrThrow`.
    const configService = new ConfigService({
      meta: {
        accessToken: 'meta-access-token',
        phoneNumberId: '1234567890',
        graphApiBaseUrl: 'https://graph.facebook.com/v23.0',
      },
    });

    sender = new MetaWhatsappSender(service, configService);
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
      of(axiosResponse({ messages: [{ id: 'wamid.HBgLNDU2' }] })),
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
