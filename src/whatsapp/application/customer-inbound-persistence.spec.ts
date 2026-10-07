import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignatureGuard } from '../presentation/signature.guard';
import type { CustomerInboundObservationStore } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import { captureCustomerInboundObservations } from './customer-inbound-persistence';

const observedAt = '2026-06-22T13:00:00.000Z';
const earlier = '2026-06-22T12:30:00.000Z';
const phone = '123456789';
const secret = 'local-test-secret';
const message = (id = 'first') => ({
  id,
  from: '5215555555555',
  timestamp: '1782129600',
  type: 'text',
  text: { body: 'private content' },
});
const observation = (id = 'first') => ({
  senderId: message().from,
  receivingPhoneNumberId: phone,
  messageId: id,
  providerTimestampSeconds: message().timestamp,
  observedAt,
});
function signed(messages: unknown[] = [message()], enabled = true) {
  const rawBody = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: phone },
                messages,
              },
            },
          ],
        },
      ],
    }),
  );
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
  guard.canActivate({
    switchToHttp: () => ({ getRequest: () => req }),
  } as ExecutionContext);
  return req;
}
function setup(enabled: unknown = true) {
  const record = jest
    .fn<ReturnType<CustomerInboundObservationStore['record']>, [unknown]>()
    .mockImplementation((input) =>
      Promise.resolve({
        kind: 'recorded',
        observation: input as ReturnType<typeof observation>,
      }),
    );
  const readLatest = jest.fn();
  const options = {
    enabled,
    phone,
    isOpsSender: (id: string) => id === 'ops',
    isKnownOutbound: (id: string) => id === 'outbound',
  };
  const capture = (req: unknown) =>
    captureCustomerInboundObservations(req, options, { record, readLatest });
  return { record, readLatest, capture };
}

beforeEach(() => jest.useFakeTimers({ now: new Date(observedAt) }));
afterEach(() => jest.useRealTimers());

describe('unwired authenticated inbound persistence', () => {
  it.each([false, null, 'true', 1])(
    'disabled %p performs no persistence',
    async (enabled) => {
      const s = setup(enabled);
      const result = await s.capture(signed());
      expect(result).toEqual({ action: 'disabled' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(s.record).not.toHaveBeenCalled();
      expect(s.readLatest).not.toHaveBeenCalled();
    },
  );
  it('rejects forged prepared data, cloned requests and missing snapshots before I/O', async () => {
    const s = setup();
    for (const req of [
      { action: 'prepared', observations: [observation()] },
      { ...signed() },
      signed([message()], false),
      null,
    ])
      expect(await s.capture(req)).toEqual({ action: 'hold' });
    expect(s.record).not.toHaveBeenCalled();
    expect(s.readLatest).not.toHaveBeenCalled();
  });
  it('preflights the complete batch before writing any prefix', async () => {
    const s = setup();
    expect(
      await s.capture(
        signed([message(), { ...message('bad'), timestamp: '01' }]),
      ),
    ).toEqual({ action: 'hold' });
    expect(s.record).not.toHaveBeenCalled();
    expect(s.readLatest).not.toHaveBeenCalled();
  });
  it('preserves filtering and empty-batch behavior without I/O', async () => {
    const s = setup();
    expect(
      await s.capture(
        signed([
          { ...message(), from: 'ops' },
          message('outbound'),
          { ...message(), type: 'system' },
        ]),
      ),
    ).toEqual({ action: 'captured', observations: [] });
    expect(s.record).not.toHaveBeenCalled();
    expect(s.readLatest).not.toHaveBeenCalled();
  });
  it('uses private snapshot metadata, persists sequentially and detaches frozen results', async () => {
    const s = setup();
    const persisted = observation();
    let release!: () => void;
    s.record.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: 'recorded', observation: persisted });
        }),
    );
    const req = signed([message(), { ...message('second'), type: 'image' }]);
    req.rawBody.fill(0);
    jest.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const pending = s.capture(req);
    expect(s.record.mock.calls).toEqual([[observation()]]);
    release();
    const result = await pending;
    expect(s.record.mock.calls).toEqual([
      [observation()],
      [observation('second')],
    ]);
    expect(result).toEqual({
      action: 'captured',
      observations: [observation(), observation('second')],
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.action !== 'captured') throw Error('not captured');
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(result.observations.every(Object.isFrozen)).toBe(true);
    expect(s.record.mock.calls.every(([input]) => Object.isFrozen(input))).toBe(
      true,
    );
    persisted.messageId = 'mutated';
    expect(result.observations[0]).toEqual(observation());
    expect(JSON.stringify(result)).not.toContain('private content');
    expect(s.readLatest).not.toHaveBeenCalled();
  });
  it('retains the first stored observation on replay rather than verification time', async () => {
    const s = setup();
    s.record.mockResolvedValueOnce({
      kind: 'replay',
      observation: { ...observation(), observedAt: earlier },
    });
    expect(await s.capture(signed())).toEqual({
      action: 'captured',
      observations: [{ ...observation(), observedAt: earlier }],
    });
    expect(s.record.mock.calls).toEqual([[observation()]]);
    expect(s.readLatest).not.toHaveBeenCalled();
  });
  it.each([
    ['recorded', { messageId: 'other' }],
    ['replay', { messageId: 'other' }],
    ['recorded', { senderId: 'other' }],
    ['replay', { senderId: 'other' }],
    ['recorded', { receivingPhoneNumberId: 'other' }],
    ['replay', { receivingPhoneNumberId: 'other' }],
    ['recorded', { providerTimestampSeconds: '1782129599' }],
    ['replay', { providerTimestampSeconds: '1782129599' }],
    ['recorded', { observedAt: earlier }],
    ['replay', { observedAt: 'invalid' }],
    ['recorded', { extra: 'private content' }],
    ['replay', { extra: 'private content' }],
  ])('holds mismatched %s metadata %p and stops', async (kind, delta) => {
    const s = setup();
    s.record.mockResolvedValueOnce({
      kind,
      observation: { ...observation(), ...delta },
    } as Awaited<ReturnType<CustomerInboundObservationStore['record']>>);
    const result = await s.capture(signed([message(), message('second')]));
    expect(result).toEqual({ action: 'hold' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(s.record.mock.calls).toEqual([[observation()]]);
    expect(s.readLatest).not.toHaveBeenCalled();
  });
  it.each([
    null,
    undefined,
    {},
    { kind: 'other' },
    { kind: 'recorded' },
    { kind: 'hold' },
  ])(
    'holds malformed or rejected storage results %p without retry',
    async (response) => {
      const s = setup();
      s.record.mockResolvedValueOnce(
        response as Awaited<
          ReturnType<CustomerInboundObservationStore['record']>
        >,
      );
      expect(await s.capture(signed([message(), message('second')]))).toEqual({
        action: 'hold',
      });
      expect(s.record.mock.calls).toEqual([[observation()]]);
      expect(s.readLatest).not.toHaveBeenCalled();
    },
  );
  it.each(['hold', 'throw'])(
    'stops after a persisted prefix on %s, without retry or rollback',
    async (failure) => {
      const s = setup();
      const saved: unknown[] = [];
      const error = new Error('uncertain write');
      s.record
        .mockImplementationOnce((input) => {
          saved.push(input);
          return Promise.resolve({
            kind: 'recorded',
            observation: observation(),
          });
        })
        .mockImplementationOnce(() => {
          if (failure === 'throw') return Promise.reject(error);
          return Promise.resolve({ kind: 'hold' });
        });
      const pending = s.capture(
        signed([message(), message('second'), message('third')]),
      );
      if (failure === 'throw') await expect(pending).rejects.toBe(error);
      else expect(await pending).toEqual({ action: 'hold' });
      expect(saved).toEqual([observation()]);
      expect(s.record.mock.calls).toEqual([
        [observation()],
        [observation('second')],
      ]);
      expect(s.readLatest).not.toHaveBeenCalled();
    },
  );
});
