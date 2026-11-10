import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import type {
  OutboundTranscriptEntry,
  OutboundTranscriptRecorder,
} from '../../conversation-transcript/application/transcript-recorder';
import { MetaWhatsappSender } from './meta-whatsapp.sender';

const TO = '5215550001111';

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

describe('MetaWhatsappSender transcript (S1)', () => {
  let post: jest.SpiedFunction<HttpService['post']>;
  let entries: OutboundTranscriptEntry[];
  let recorder: OutboundTranscriptRecorder;
  let sender: MetaWhatsappSender;
  let sandbox: boolean;
  let opsPhone: string | undefined;

  const accept = (...ids: string[]) => {
    for (const id of ids)
      post.mockReturnValueOnce(of(axiosResponse({ messages: [{ id }] })));
  };

  beforeEach(() => {
    const http = new HttpService();
    post = jest
      .spyOn(http, 'post')
      .mockImplementation(() =>
        throwError(() => new Error('unexpected network request')),
      );
    entries = [];
    recorder = {
      recordOutbound: jest.fn((entry: OutboundTranscriptEntry) => {
        entries.push(entry);
        return Promise.resolve();
      }),
    };
    sandbox = false;
    opsPhone = undefined;
    const config = new ConfigService({
      humanHandoff: {
        get opsChannelPhone() {
          return opsPhone;
        },
      },
      meta: {
        accessToken: 't',
        phoneNumberId: '1',
        graphApiBaseUrl: 'https://graph.facebook.com/v23.0',
        get sandboxRecipientNormalizationEnabled() {
          return sandbox;
        },
      },
    });
    sender = new MetaWhatsappSender(http, config, recorder);
  });

  it('records a sent text under the raw wa_id, even with the sandbox rewrite', async () => {
    sandbox = true;
    accept('wamid.text');
    await sender.sendText({ to: TO, text: 'hola' });
    expect(entries).toEqual([
      { to: TO, providerMessageId: 'wamid.text', type: 'text', text: 'hola' },
    ]);
  });

  it('records an image with its caption and link', async () => {
    accept('wamid.img');
    await sender.sendImage({
      to: TO,
      link: 'https://cdn.example.com/a.jpg',
      caption: 'Croquetas',
    });
    expect(entries).toEqual([
      {
        to: TO,
        providerMessageId: 'wamid.img',
        type: 'image',
        text: 'Croquetas',
        media: { link: 'https://cdn.example.com/a.jpg' },
      },
    ]);
  });

  it('records a template with its name, language and parameters', async () => {
    accept('wamid.tpl');
    await sender.sendTemplate({
      to: TO,
      templateName: 'order_ready',
      languageCode: 'es_MX',
      bodyParameters: ['F-1'],
    });
    expect(entries).toEqual([
      {
        to: TO,
        providerMessageId: 'wamid.tpl',
        type: 'template',
        details: {
          templateName: 'order_ready',
          languageCode: 'es_MX',
          bodyParameters: ['F-1'],
        },
      },
    ]);
  });

  it('records each message of a long interactive send', async () => {
    accept('wamid.long-text', 'wamid.controls');
    await sender.sendInteractive({
      to: TO,
      body: 'x'.repeat(1100),
      shortBody: '¿Confirma?',
      interactive: {
        type: 'buttons',
        buttons: [{ id: 'confirm_yes', title: 'Sí' }],
      },
    });
    expect(
      entries.map((entry) => [entry.providerMessageId, entry.type]),
    ).toEqual([
      ['wamid.long-text', 'text'],
      ['wamid.controls', 'interactive'],
    ]);
    expect(entries[1]).toMatchObject({
      text: '¿Confirma?',
      details: {
        interactive: {
          type: 'button',
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'confirm_yes', title: 'Sí' } },
            ],
          },
        },
      },
    });
  });

  it('never records a send to the ops phone (it is not a customer conversation)', async () => {
    opsPhone = '5215500000000';
    accept('wamid.ops', 'wamid.customer');
    await sender.sendText({ to: '5215500000000', text: 'HF-1 pendiente' });
    await sender.sendText({ to: TO, text: 'hola' });
    expect(entries.map((entry) => entry.providerMessageId)).toEqual([
      'wamid.customer',
    ]);
  });

  it('matches the ops phone under the sandbox normalization only when enabled', async () => {
    opsPhone = '525500000000';
    accept('wamid.exact');
    await sender.sendText({ to: '5215500000000', text: 'x' });
    expect(entries).toHaveLength(1);
    sandbox = true;
    accept('wamid.sandbox');
    await sender.sendText({ to: '5215500000000', text: 'x' });
    expect(entries).toHaveLength(1);
  });

  it('records nothing when Meta refuses the send', async () => {
    await expect(sender.sendText({ to: TO, text: 'hola' })).rejects.toThrow();
    expect(entries).toEqual([]);
  });

  it('a failing recorder never fails the send', async () => {
    recorder.recordOutbound = () => Promise.reject(new Error('db down'));
    accept('wamid.ok');
    await expect(sender.sendText({ to: TO, text: 'hola' })).resolves.toEqual({
      providerMessageId: 'wamid.ok',
    });
  });

  it('works without a recorder', async () => {
    const http = new HttpService();
    jest
      .spyOn(http, 'post')
      .mockReturnValue(of(axiosResponse({ messages: [{ id: 'wamid.bare' }] })));
    const bare = new MetaWhatsappSender(
      http,
      new ConfigService({
        meta: {
          accessToken: 't',
          phoneNumberId: '1',
          graphApiBaseUrl: 'https://graph.facebook.com/v23.0',
        },
      }),
    );
    await expect(bare.sendText({ to: TO, text: 'hola' })).resolves.toEqual({
      providerMessageId: 'wamid.bare',
    });
  });
});
