import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { InboundMessage } from '../domain/inbound-message';
import {
  InvalidOutboundTemplateError,
  OutboundImage,
  OutboundInteractive,
  OutboundTemplate,
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
  let sandboxRecipientNormalizationEnabled: boolean;

  beforeEach(() => {
    const service = new HttpService();
    sandboxRecipientNormalizationEnabled = false;
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
        get sandboxRecipientNormalizationEnabled() {
          return sandboxRecipientNormalizationEnabled;
        },
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

  it('sends one Graph API text request preserving the exact wa_id by default and returns the provider message id', async () => {
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
    httpService.post.mockReturnValue(
      of(axiosResponse({ messages: [{ id: 'w' }] })),
    );
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

  describe('sendTemplate', () => {
    const template: OutboundTemplate = {
      to: '5215550001111',
      templateName: 'delivery_zone_resolved',
      languageCode: 'es_MX',
      bodyParameters: ['Ana'],
    };

    it('sends one Graph API template request with one body parameter and returns the provider message id', async () => {
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'wamid.TPL1' }] })),
      );

      await expect(sender.sendTemplate(template)).resolves.toEqual({
        providerMessageId: 'wamid.TPL1',
      });

      expect(httpService.post).toHaveBeenCalledTimes(1);
      expect(httpService.post).toHaveBeenCalledWith(
        'https://graph.facebook.com/v23.0/1234567890/messages',
        {
          messaging_product: 'whatsapp',
          to: '5215550001111',
          type: 'template',
          template: {
            name: 'delivery_zone_resolved',
            language: { code: 'es_MX' },
            components: [
              {
                type: 'body',
                parameters: [{ type: 'text', text: 'Ana' }],
              },
            ],
          },
        },
        {
          headers: {
            Authorization: 'Bearer meta-access-token',
          },
        },
      );
    });

    it('keeps two body parameters in order and passes the language code through', async () => {
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'wamid.TPL2' }] })),
      );

      await sender.sendTemplate({
        ...template,
        languageCode: 'en_US',
        bodyParameters: ['Ana', '06700'],
      });

      expect(httpService.post).toHaveBeenCalledWith(
        expect.anything(),
        {
          messaging_product: 'whatsapp',
          to: '5215550001111',
          type: 'template',
          template: {
            name: 'delivery_zone_resolved',
            language: { code: 'en_US' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: 'Ana' },
                  { type: 'text', text: '06700' },
                ],
              },
            ],
          },
        },
        expect.anything(),
      );
    });

    it('omits the body component for a template without variables', async () => {
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'w' }] })),
      );

      await sender.sendTemplate({ ...template, bodyParameters: [] });

      expect(httpService.post).toHaveBeenCalledWith(
        expect.anything(),
        {
          messaging_product: 'whatsapp',
          to: '5215550001111',
          type: 'template',
          template: {
            name: 'delivery_zone_resolved',
            language: { code: 'es_MX' },
          },
        },
        expect.anything(),
      );
    });

    it('rewrites the trunk-1 recipient only when normalization is enabled', async () => {
      sandboxRecipientNormalizationEnabled = true;
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'w' }] })),
      );

      await sender.sendTemplate(template);

      expect(httpService.post).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ to: '525550001111' }),
        expect.anything(),
      );
    });

    it.each<[string, Partial<OutboundTemplate>]>([
      ['uppercase name', { templateName: 'Delivery_Zone' }],
      ['name with a dash', { templateName: 'delivery-zone' }],
      ['empty name', { templateName: '' }],
      ['name over 512 chars', { templateName: 'a'.repeat(513) }],
      ['empty language code', { languageCode: '' }],
      ['empty recipient', { to: '' }],
      ['empty parameter', { bodyParameters: [''] }],
      ['whitespace-only parameter', { bodyParameters: ['   '] }],
      ['untrimmed parameter', { bodyParameters: [' Ana'] }],
      ['newline in parameter', { bodyParameters: ['Ana\nLópez'] }],
      ['tab in parameter', { bodyParameters: ['Ana\tLópez'] }],
      ['five consecutive spaces', { bodyParameters: ['Ana     López'] }],
      ['parameter over 1024 chars', { bodyParameters: ['a'.repeat(1025)] }],
      [
        'non-array parameters',
        { bodyParameters: 'Ana' as unknown as string[] },
      ],
    ])('rejects %s before any request', async (_label, override) => {
      await expect(
        sender.sendTemplate({ ...template, ...override }),
      ).rejects.toThrow(InvalidOutboundTemplateError);
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('accepts boundary values: 512-char name, 1024-char parameter, four consecutive spaces', async () => {
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'w' }] })),
      );

      await expect(
        sender.sendTemplate({
          ...template,
          templateName: 'a'.repeat(512),
          bodyParameters: ['a'.repeat(1024), 'Ana    López'],
        }),
      ).resolves.toEqual({ providerMessageId: 'w' });
    });

    it('maps a Graph API rejection to the same sanitized typed error as sendText', async () => {
      const token = 'meta-access-token';
      httpService.post.mockReturnValue(
        throwError(() => ({
          isAxiosError: true,
          config: { headers: { Authorization: `Bearer ${token}` } },
          response: {
            status: 400,
            data: {
              error: { code: 132001, message: 'Template does not exist' },
            },
          },
        })),
      );

      let thrown: unknown;
      try {
        await sender.sendTemplate(template);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(WhatsappSendError);
      expect((thrown as WhatsappSendError).status).toBe(400);
      expect((thrown as WhatsappSendError).graphErrorCode).toBe(132001);
      expect((thrown as WhatsappSendError).graphErrorMessage).toBe(
        'Template does not exist',
      );
      expect(JSON.stringify(thrown)).not.toContain(token);
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('fails when Meta omits the provider message id', async () => {
      httpService.post.mockReturnValue(of(axiosResponse({ messages: [] })));

      await expect(sender.sendTemplate(template)).rejects.toThrow(
        'Meta response did not include a provider message id',
      );
    });
  });

  describe('sendImage', () => {
    const image: OutboundImage = {
      to: '5215550001111',
      link: 'https://cdn.example.test/products/kong.jpg',
      caption: 'Kong Classic',
    };

    it('sends one Graph API image message by link with its caption and returns the provider message id', async () => {
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'wamid.IMG1' }] })),
      );

      await expect(sender.sendImage(image)).resolves.toEqual({
        providerMessageId: 'wamid.IMG1',
      });

      expect(httpService.post).toHaveBeenCalledTimes(1);
      expect(httpService.post).toHaveBeenCalledWith(
        'https://graph.facebook.com/v23.0/1234567890/messages',
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '5215550001111',
          type: 'image',
          image: {
            link: 'https://cdn.example.test/products/kong.jpg',
            caption: 'Kong Classic',
          },
        },
        {
          headers: {
            Authorization: 'Bearer meta-access-token',
          },
        },
      );
    });

    it('omits an absent caption', async () => {
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'w' }] })),
      );

      await sender.sendImage({ to: image.to, link: image.link });

      expect(httpService.post).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'image',
          image: { link: image.link },
        }),
        expect.anything(),
      );
    });

    it('rewrites the trunk-1 recipient only when normalization is enabled', async () => {
      sandboxRecipientNormalizationEnabled = true;
      httpService.post.mockReturnValue(
        of(axiosResponse({ messages: [{ id: 'w' }] })),
      );

      await sender.sendImage(image);

      expect(httpService.post).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ to: '525550001111' }),
        expect.anything(),
      );
    });

    it.each<[string, Partial<OutboundImage>]>([
      ['plain http link', { link: 'http://cdn.example.test/kong.jpg' }],
      ['relative link', { link: '/products/kong.jpg' }],
      ['empty recipient', { to: '' }],
      ['non-string caption', { caption: 7 as unknown as string }],
    ])('rejects %s before any request', async (_label, override) => {
      await expect(sender.sendImage({ ...image, ...override })).rejects.toThrow(
        UnsupportedOutboundError,
      );
      expect(httpService.post).not.toHaveBeenCalled();
    });

    it('maps a Graph API rejection to the same sanitized typed error as sendText', async () => {
      const token = 'meta-access-token';
      httpService.post.mockReturnValue(
        throwError(() => ({
          isAxiosError: true,
          config: { headers: { Authorization: `Bearer ${token}` } },
          response: {
            status: 400,
            data: {
              error: { code: 131053, message: 'Media upload error' },
            },
          },
        })),
      );

      let thrown: unknown;
      try {
        await sender.sendImage(image);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(WhatsappSendError);
      expect((thrown as WhatsappSendError).graphErrorCode).toBe(131053);
      expect(JSON.stringify(thrown)).not.toContain(token);
      expect(httpService.post).toHaveBeenCalledTimes(1);
    });

    it('fails when Meta omits the provider message id', async () => {
      httpService.post.mockReturnValue(of(axiosResponse({ messages: [] })));

      await expect(sender.sendImage(image)).rejects.toThrow(
        'Meta response did not include a provider message id',
      );
    });
  });
});

describe('MetaWhatsappSender.sendInteractive (S4)', () => {
  let post: jest.SpiedFunction<HttpService['post']>;
  let sender: MetaWhatsappSender;
  let normalization: boolean;
  const URL = 'https://graph.facebook.com/v23.0/1234567890/messages';
  const AUTH = { headers: { Authorization: 'Bearer meta-access-token' } };

  beforeEach(() => {
    const service = new HttpService();
    normalization = false;
    let n = 0;
    post = jest
      .spyOn(service, 'post')
      .mockImplementation(() =>
        of(axiosResponse({ messages: [{ id: `wamid.${(n += 1)}` }] })),
      );
    sender = new MetaWhatsappSender(
      service,
      new ConfigService({
        meta: {
          accessToken: 'meta-access-token',
          phoneNumberId: '1234567890',
          graphApiBaseUrl: 'https://graph.facebook.com/v23.0',
          get sandboxRecipientNormalizationEnabled() {
            return normalization;
          },
        },
      }),
    );
  });

  const buttons: OutboundInteractive = {
    to: '5215550001111',
    body: 'Resumen de su pedido:\n• Kong: 1 × $329.00',
    interactive: {
      type: 'buttons',
      buttons: [
        { id: 'order_confirm:ref-1', title: '✅ Confirmar pedido' },
        { id: 'order_change', title: '✏️ Cambiar algo' },
      ],
    },
    shortBody: '¿Confirma su pedido?',
  };

  it('sends reply buttons as one Graph API interactive message', async () => {
    await expect(sender.sendInteractive(buttons)).resolves.toEqual({
      providerMessageId: 'wamid.1',
      providerMessageIds: ['wamid.1'],
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      URL,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5215550001111',
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: buttons.body },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'order_confirm:ref-1',
                  title: '✅ Confirmar pedido',
                },
              },
              {
                type: 'reply',
                reply: { id: 'order_change', title: '✏️ Cambiar algo' },
              },
            ],
          },
        },
      },
      AUTH,
    );
  });

  it('sends a list with its button text and one section of rows', async () => {
    await sender.sendInteractive({
      to: '5215550001111',
      body: '¿Qué presentación desea agregar: 10 kg o 20 kg?',
      interactive: {
        type: 'list',
        buttonText: 'Ver opciones',
        sectionTitle: 'Presentaciones',
        rows: [
          { id: 'pick_variant:a', title: '10 kg — $219' },
          { id: 'pick_variant:b', title: '20 kg — $389', description: 'Arena' },
        ],
      },
    });
    expect(post).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: '¿Qué presentación desea agregar: 10 kg o 20 kg?' },
          action: {
            button: 'Ver opciones',
            sections: [
              {
                title: 'Presentaciones',
                rows: [
                  { id: 'pick_variant:a', title: '10 kg — $219' },
                  {
                    id: 'pick_variant:b',
                    title: '20 kg — $389',
                    description: 'Arena',
                  },
                ],
              },
            ],
          },
        },
      }),
      AUTH,
    );
  });

  it('shortens titles, descriptions and button text to the Meta limits and keeps at most 3 buttons / 10 rows', async () => {
    await sender.sendInteractive({
      ...buttons,
      interactive: {
        type: 'buttons',
        buttons: [
          { id: 'a', title: '✅ Un título de botón demasiado largo' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ],
      },
    });
    const sentButtons = (
      post.mock.calls[0][1] as {
        interactive: {
          action: { buttons: Array<{ reply: { title: string } }> };
        };
      }
    ).interactive.action.buttons;
    expect(sentButtons).toHaveLength(3);
    expect(sentButtons[0].reply.title.length).toBeLessThanOrEqual(20);
    expect(sentButtons[0].reply.title).toMatch(/^✅ Un título.*…$/);

    await sender.sendInteractive({
      to: '5215550001111',
      body: 'Elija',
      interactive: {
        type: 'list',
        buttonText: 'Ver todas las opciones disponibles',
        rows: Array.from({ length: 12 }, (_, i) => ({
          id: `pick_product:${i}`,
          title: `Producto con un nombre muy largo número ${i}`,
          description: 'd'.repeat(100),
        })),
      },
    });
    const list = (
      post.mock.calls[1][1] as {
        interactive: {
          action: {
            button: string;
            sections: Array<{
              rows: Array<{ title: string; description?: string }>;
            }>;
          };
        };
      }
    ).interactive.action;
    expect(list.button.length).toBeLessThanOrEqual(20);
    expect(list.sections[0].rows).toHaveLength(10);
    for (const row of list.sections[0].rows) {
      expect(row.title.length).toBeLessThanOrEqual(24);
      expect((row.description ?? '').length).toBeLessThanOrEqual(72);
    }
  });

  it('sends a body over 1024 chars first as text, then the controls with the short body', async () => {
    const long = `Resumen de su pedido:\n${'• línea\n'.repeat(200)}`;
    await expect(
      sender.sendInteractive({ ...buttons, body: long }),
    ).resolves.toEqual({
      providerMessageId: 'wamid.2',
      providerMessageIds: ['wamid.1', 'wamid.2'],
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ type: 'text', text: { body: long } }),
    );
    expect(post.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        type: 'interactive',
        interactive: expect.objectContaining({
          body: { text: '¿Confirma su pedido?' },
        }) as unknown,
      }),
    );
  });

  it('keeps the delivered text when the controls after a long body fail', async () => {
    let n = 0;
    post.mockImplementation(() =>
      (n += 1) === 1
        ? of(axiosResponse({ messages: [{ id: 'wamid.text' }] }))
        : throwError(() => ({ response: { status: 400, data: {} } })),
    );
    await expect(
      sender.sendInteractive({ ...buttons, body: 'x'.repeat(1100) }),
    ).resolves.toEqual({
      providerMessageId: 'wamid.text',
      providerMessageIds: ['wamid.text'],
    });
  });

  it('rewrites the trunk-1 recipient only when normalization is enabled', async () => {
    normalization = true;
    await sender.sendInteractive(buttons);
    expect(post).toHaveBeenLastCalledWith(
      URL,
      expect.objectContaining({ to: '525550001111' }),
      AUTH,
    );
  });

  it.each<[string, Partial<OutboundInteractive>]>([
    ['empty recipient', { to: '' }],
    ['empty body', { body: '' }],
    ['no buttons', { interactive: { type: 'buttons', buttons: [] } }],
    [
      'an empty button id',
      { interactive: { type: 'buttons', buttons: [{ id: '', title: 'A' }] } },
    ],
    ['no rows', { interactive: { type: 'list', buttonText: 'Ver', rows: [] } }],
  ])('rejects %s before any request', async (_label, override) => {
    await expect(
      sender.sendInteractive({ ...buttons, ...override }),
    ).rejects.toThrow(UnsupportedOutboundError);
    expect(post).not.toHaveBeenCalled();
  });

  it('maps a Graph API rejection to the same sanitized typed error as sendText', async () => {
    post.mockReturnValue(
      throwError(() => ({
        response: {
          status: 400,
          data: {
            error: { code: 131009, message: 'Parameter value is not valid' },
          },
        },
      })),
    );
    await expect(sender.sendInteractive(buttons)).rejects.toBeInstanceOf(
      WhatsappSendError,
    );
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
