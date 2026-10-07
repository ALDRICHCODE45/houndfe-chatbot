import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignatureGuard } from '../presentation/signature.guard';
import { prepareCustomerInboundObservations } from './customer-inbound-capture';

const observedAt = '2026-06-22T13:00:00.000Z';
const phone = '123456789';
const secret = 'local-test-secret';
const message = (id = 'inbound') => ({
  id,
  from: '5215555555555',
  timestamp: '1782129600',
  type: 'text',
  text: { body: 'private customer content' },
});
const value = (messages: unknown = [message()], channel = phone) => ({
  metadata: { phone_number_id: channel },
  messages,
});
const event = (values: unknown[] = [value()]) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: values.map((value) => ({ field: 'messages', value })) }],
});
const observation = (id = 'inbound') => ({
  senderId: message().from,
  receivingPhoneNumberId: phone,
  messageId: id,
  providerTimestampSeconds: message().timestamp,
  observedAt,
});
function request(input: unknown = event(), enabled = true) {
  const rawBody = Buffer.isBuffer(input)
    ? input
    : Buffer.from(JSON.stringify(input));
  const req = {
    rawBody,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    },
  };
  const guard = new SignatureGuard(
    new ConfigService({
      meta: { appSecret: secret },
      humanDecisions: { restockEnabled: enabled },
    }),
  );
  const verify = () =>
    guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext);
  verify();
  return { req, verify };
}
function setup(enabled: unknown = true) {
  const ops = jest.fn((sender: string) => sender === 'ops');
  const echo = jest.fn((id: string) => id === 'outbound');
  const capture = (req: unknown) =>
    prepareCustomerInboundObservations(req, {
      enabled,
      phone,
      isOpsSender: ops,
      isKnownOutbound: echo,
    });
  const run = (input: unknown = event()) => capture(request(input).req);
  return { capture, run, ops, echo };
}

beforeEach(() => jest.useFakeTimers({ now: new Date(observedAt) }));
afterEach(() => jest.useRealTimers());

describe('unwired authenticated customer inbound capture', () => {
  it.each([false, null, 'true', 1])(
    'strict opt-in rejects %p without effects',
    (enabled) => {
      const s = setup(enabled);
      const unreadable = new Proxy(
        {},
        {
          get: () => {
            throw Error('read');
          },
        },
      );
      expect(s.capture(unreadable)).toEqual({
        action: 'disabled',
      });
      expect(s.ops).not.toHaveBeenCalled();
      expect(s.echo).not.toHaveBeenCalled();
    },
  );
  it('rejects body/snapshot forgeries, clones, proxies and flag-disabled snapshots', () => {
    const s = setup();
    const { req } = request();
    for (const untrusted of [
      null,
      undefined,
      'raw request',
      { body: event() },
      { rawBodyBase64: req.rawBody.toString('base64'), observedAt },
      { ...req },
      new Proxy(req, {}),
      request(event(), false).req,
    ])
      expect(s.capture(untrusted)).toEqual({ action: 'hold' });
    expect(s.ops).not.toHaveBeenCalled();
    expect(s.echo).not.toHaveBeenCalled();
  });
  it('failed re-verification revokes the previous request snapshot', () => {
    const s = setup();
    const { req, verify } = request();
    req.headers['x-hub-signature-256'] = `sha256=${'00'.repeat(32)}`;
    expect(verify).toThrow('Invalid X-Hub-Signature-256 header');
    expect(s.capture(req)).toEqual({ action: 'hold' });
  });
  it.each([
    'text',
    'image',
    'audio',
    'video',
    'document',
    'sticker',
    'location',
    'contacts',
    'interactive',
    'button',
    'reaction',
  ])(
    'prepares only verified %s metadata, including reaction removal',
    (type) => {
      const s = setup();
      const inbound = {
        ...message(),
        type,
        reaction: { message_id: 'outbound' },
      };
      const { req } = request(event([value([inbound])]));
      req.rawBody.fill(0);
      Object.defineProperty(req, 'body', {
        get: () => {
          throw Error('body');
        },
      });
      jest.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      const result = s.capture(req);
      expect(result).toEqual({
        action: 'prepared',
        observations: [observation()],
      });
      expect(Object.isFrozen(result)).toBe(true);
      if (result.action !== 'prepared') throw Error('not prepared');
      expect(Object.isFrozen(result.observations)).toBe(true);
      expect(Object.isFrozen(result.observations[0])).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private customer content');
      expect(s.echo).toHaveBeenCalledWith('inbound');
      expect(s.echo).not.toHaveBeenCalledWith('outbound');
    },
  );
  it('isolates excluded types, channels, ops, echoes and non-message notifications', () => {
    const s = setup();
    const ignored = [
      'system',
      'unsupported',
      'unknown',
      'call',
      'future_type',
    ].map((type) => ({ ...message(type), type, timestamp: 'bad' }));
    const input = event([
      { statuses: [{ id: 'status', timestamp: '9999999999' }] },
      value(null, '987'),
      value([
        ...ignored,
        { ...message(), from: 'ops', timestamp: 'bad' },
        { ...message('outbound'), timestamp: 'bad' },
        message(),
        { ...message('media'), type: 'image' },
      ]),
    ]);
    input.entry[0].changes.push({ field: 'calls', value: null });
    expect(s.run(input)).toEqual({
      action: 'prepared',
      observations: [observation(), observation('media')],
    });
  });
  it.each([
    Buffer.from([0xff]),
    Buffer.from('{'),
    {},
    { ...event(), object: 'other' },
    { ...event(), entry: [{}] },
    event([{ messages: [] }]),
    event([value(null)]),
    event([value(), value([{ ...message('bad'), timestamp: '01' }])]),
    event([value(), value([{ ...message('bad'), timestamp: '9999999999' }])]),
    event([value(), value([{ ...message('bad'), from: '' }])]),
  ])(
    'holds malformed eligible batches without partial evidence: %p',
    (input) => {
      const s = setup();
      expect(s.run(input)).toEqual({ action: 'hold' });
    },
  );
  it('empty/status-only input prepares no observations', () => {
    const s = setup();
    expect(s.run(event([{ statuses: [] }, value([])]))).toEqual({
      action: 'prepared',
      observations: [],
    });
  });
});
