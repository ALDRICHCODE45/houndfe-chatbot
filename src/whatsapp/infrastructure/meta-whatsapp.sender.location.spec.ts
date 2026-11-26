import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import type { OutboundTranscriptEntry } from '../../conversation-transcript/application/transcript-recorder';
import { UnsupportedOutboundError } from '../domain/whatsapp-sender.port';
import { MetaWhatsappSender } from './meta-whatsapp.sender';

/**
 * T2 H3 (S3): the native WhatsApp location message (Graph API
 * `type: 'location'`) for the store pin.
 */
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

describe('MetaWhatsappSender.sendLocation (T2 H3)', () => {
  let post: jest.SpiedFunction<HttpService['post']>;
  let entries: OutboundTranscriptEntry[];
  let sender: MetaWhatsappSender;

  beforeEach(() => {
    const http = new HttpService();
    post = jest
      .spyOn(http, 'post')
      .mockImplementation(() =>
        throwError(() => new Error('unexpected network request')),
      );
    entries = [];
    sender = new MetaWhatsappSender(
      http,
      new ConfigService({
        meta: {
          accessToken: 't',
          phoneNumberId: '1',
          graphApiBaseUrl: 'https://graph.facebook.com/v23.0',
        },
      }),
      {
        recordOutbound: (entry: OutboundTranscriptEntry) => {
          entries.push(entry);
          return Promise.resolve();
        },
      },
    );
  });

  it('posts the Graph API location body and records it in the transcript', async () => {
    post.mockReturnValueOnce(
      of(axiosResponse({ messages: [{ id: 'wamid.pin' }] })),
    );
    await expect(
      sender.sendLocation({
        to: TO,
        latitude: 19.4326,
        longitude: -99.1332,
        name: 'Sucursal Centro',
        address: 'Av. Juárez 123, Centro',
      }),
    ).resolves.toEqual({ providerMessageId: 'wamid.pin' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'location',
      location: {
        latitude: 19.4326,
        longitude: -99.1332,
        name: 'Sucursal Centro',
        address: 'Av. Juárez 123, Centro',
      },
    });
    expect(entries).toEqual([
      expect.objectContaining({
        to: TO,
        providerMessageId: 'wamid.pin',
        type: 'location',
        details: {
          location: {
            latitude: 19.4326,
            longitude: -99.1332,
            name: 'Sucursal Centro',
            address: 'Av. Juárez 123, Centro',
          },
        },
      }),
    ]);
  });

  it('omits name and address when absent', async () => {
    post.mockReturnValueOnce(
      of(axiosResponse({ messages: [{ id: 'wamid.pin' }] })),
    );
    await sender.sendLocation({ to: TO, latitude: 0, longitude: 0 });
    expect(post.mock.calls[0][1]).toMatchObject({
      type: 'location',
      location: { latitude: 0, longitude: 0 },
    });
    expect(
      Object.keys(
        (post.mock.calls[0][1] as { location: Record<string, unknown> })
          .location,
      ),
    ).toEqual(['latitude', 'longitude']);
  });

  it.each([
    ['no recipient', { to: '', latitude: 1, longitude: 1 }],
    ['latitude out of range', { to: TO, latitude: 90.1, longitude: 1 }],
    ['longitude out of range', { to: TO, latitude: 1, longitude: 180.5 }],
    ['non-finite', { to: TO, latitude: Number.NaN, longitude: 1 }],
    ['blank name', { to: TO, latitude: 1, longitude: 1, name: ' ' }],
  ])('refuses an invalid pin before any request (%s)', async (_n, message) => {
    await expect(sender.sendLocation(message)).rejects.toBeInstanceOf(
      UnsupportedOutboundError,
    );
    expect(post).not.toHaveBeenCalled();
  });
});
