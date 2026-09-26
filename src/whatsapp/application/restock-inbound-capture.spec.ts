import { bindRestockInboundEvidence } from '../../human-decisions/domain/restock-inbound-evidence';
import type { RestockInboundEvidencePort } from '../../human-decisions/infrastructure/postgres-restock-inbound-evidence.store';
import { RestockInboundCapture } from './restock-inbound-capture';

const observedAt = '2026-06-22T13:00:00.000Z';
const phone = '123456789';
const message = (id = 'wamid.first') => ({
  id,
  from: '5215555555555',
  timestamp: '1782129600',
  type: 'text',
  text: { body: '¿Hay café? ☕' },
});
const value = (messages: unknown = [message()]) => ({
  metadata: { phone_number_id: phone },
  contacts: [{ wa_id: '5215555555555' }],
  messages,
});
const event = (values: unknown[] = [value()]) => ({
  object: 'whatsapp_business_account',
  entry: values.map((value) => ({ changes: [{ field: 'messages', value }] })),
});
const snapshot = (input: unknown = event()) => ({
  rawBodyBase64: Buffer.from(JSON.stringify(input)).toString('base64'),
  observedAt,
});
function fixture() {
  const row = bindRestockInboundEvidence(
    {
      event: {
        receivingPhoneNumberId: phone,
        senderId: message().from,
        messageId: message().id,
      },
      providerTimestampSeconds: message().timestamp,
      observedAt,
    },
    phone,
  );
  expect(row).not.toBeNull();
  return row!;
}
function setup(enabled: unknown = true) {
  const record = jest
    .fn<
      ReturnType<RestockInboundEvidencePort['record']>,
      Parameters<RestockInboundEvidencePort['record']>
    >()
    .mockImplementation(async (evidence) => ({ action: 'recorded', evidence }));
  const ops = jest.fn((sender: string) => sender === 'ops');
  const echo = jest.fn((id: string) => id === 'echo');
  const capture = new RestockInboundCapture(
    enabled,
    phone,
    { record },
    ops,
    echo,
  );
  const run = (values: unknown[]) => capture.capture(snapshot(event(values)));
  return { record, ops, echo, capture, run };
}

describe('unwired text-only restock capture', () => {
  it.each([false, null, 'true', 1])(
    'strict disabled %p has zero effects',
    async (flag) => {
      const s = setup(flag);
      const raw = {
        get rawBodyBase64(): string {
          throw new Error('read');
        },
        observedAt,
      };
      expect(await s.capture.capture(raw)).toEqual({ action: 'disabled' });
      expect(s.record).not.toHaveBeenCalled();
      expect(s.ops).not.toHaveBeenCalled();
      expect(s.echo).not.toHaveBeenCalled();
    },
  );
  it('preserves UTF8 and provider seconds in detached event and frozen evidence', async () => {
    const s = setup();
    const input = event();
    const result = await s.capture.capture(snapshot(input));
    expect(result.action).toBe('captured');
    if (result.action !== 'captured') throw new Error('not captured');
    expect(result.event).toEqual(input);
    expect(result.event).not.toBe(input);
    expect(result.evidence).toEqual([fixture()]);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence[0])).toBe(true);
  });
  it.each([
    value([{ ...message(), timestamp: '01' }]),
    value([{ ...message(), timestamp: '9999999999' }]),
    value([{ ...message(), from: undefined }]),
    value([{ ...message(), type: 'image', image: { id: 'media' } }]),
    value([{ ...message(), image: { id: 'ambiguous' } }]),
    value([{ ...message(), audio: { id: 'ambiguous' } }]),
    { ...value(), metadata: undefined },
    { ...value(), metadata: { phone_number_id: 'other' } },
    value(null),
  ])('holds entire multi-entry batch before first write: %p', async (bad) => {
    const s = setup();
    expect(await s.run([value(), bad])).toEqual({ action: 'hold' });
    expect(s.record).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { rawBodyBase64: '/w==', observedAt },
    { rawBodyBase64: 'eA==', observedAt },
    snapshot({}),
    snapshot({ ...event(), object: 'other' }),
    snapshot({ ...event(), entry: [{}] }),
    snapshot({ ...event(), entry: [{ changes: [{}] }] }),
    { ...snapshot(), rawBodyBase64: ' e30=' },
  ])('holds absent or malformed snapshot %p', async (raw) => {
    const s = setup();
    expect(await s.capture.capture(raw)).toEqual({ action: 'hold' });
    expect(s.record).not.toHaveBeenCalled();
  });
  it('ignores status, ops and echoes by message ID before evidence binding', async () => {
    const s = setup();
    const ops = { ...message(), from: 'ops', timestamp: 'bad' };
    const echo = { ...message('echo'), timestamp: 'bad' };
    const result = await s.run([{ statuses: [] }, value([ops, echo])]);
    expect(result).toMatchObject({ action: 'captured', evidence: [] });
    expect(s.echo).toHaveBeenCalledWith('echo');
    expect(s.echo).not.toHaveBeenCalledWith(message().from);
    expect(s.record).not.toHaveBeenCalled();
  });
  it('awaits both records sequentially and detaches before first await', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.record.mockImplementationOnce(async (evidence) => {
      await gate;
      return { action: 'recorded', evidence };
    });
    let finish!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    s.record.mockImplementationOnce(async (evidence) => {
      await secondGate;
      return { action: 'recorded', evidence };
    });
    const raw = snapshot(event([value([message(), message('second')])]));
    let settled = false;
    const pending = s.capture.capture(raw).then((result) => {
      settled = true;
      return result;
    });
    expect(s.record).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    raw.rawBodyBase64 = snapshot({}).rawBodyBase64;
    raw.observedAt = '2030-01-01T00:00:00.000Z';
    release();
    await gate;
    await Promise.resolve();
    expect(s.record).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    finish();
    const result = await pending;
    expect(s.record.mock.calls.map(([row]) => row.messageId)).toEqual([
      'wamid.first',
      'second',
    ]);
    expect(result).toMatchObject({
      action: 'captured',
      evidence: [{ observedAt }, { observedAt }],
      event: event([value([message(), message('second')])]),
    });
  });
  it('propagates second storage failure; persisted prefix is not rolled back', async () => {
    const s = setup();
    const persisted: string[] = [];
    s.record.mockImplementation(async (row) => {
      if (persisted.length) throw new Error('database');
      persisted.push(row.messageId);
      return { action: 'recorded', evidence: row };
    });
    await expect(
      s.run([value([message(), message('second')])]),
    ).rejects.toThrow('database');
    expect(persisted).toEqual(['wamid.first']);
  });
  it.each(['2026-06-22T12:00:00.000Z', '2026-06-23T00:00:00.000Z'])(
    'retains valid replay observation %s',
    async (storedAt) => {
      const s = setup();
      s.record.mockResolvedValue({
        action: 'replay',
        evidence: { ...fixture(), observedAt: storedAt },
      });
      expect(await s.capture.capture(snapshot())).toMatchObject({
        action: 'captured',
        evidence: [{ observedAt: storedAt }],
      });
    },
  );
  it.each([null, undefined])('holds on %s output', async (result) => {
    const s = setup();
    s.record.mockResolvedValue(result as never);
    await expect(
      s.run([value([message(), message('second')])]),
    ).resolves.toEqual({ action: 'hold' });
    expect(s.record).toHaveBeenCalledTimes(1);
  });
  it.each(['hold', 'corrupt', 'conflict', 'recorded-observation'])(
    'stops on %s storage output',
    async (kind) => {
      const s = setup();
      const row = fixture();
      s.record.mockResolvedValue(
        kind === 'hold'
          ? { action: 'hold' }
          : {
              action: kind === 'recorded-observation' ? 'recorded' : 'replay',
              evidence: {
                ...row,
                ...(kind === 'corrupt'
                  ? { version: 2 }
                  : kind === 'conflict'
                    ? { providerTimestampSeconds: '1782129601' }
                    : { observedAt: '2026-06-23T00:00:00.000Z' }),
              } as typeof row,
            },
      );
      expect(await s.run([value([message(), message('second')])])).toEqual({
        action: 'hold',
      });
      expect(s.record).toHaveBeenCalledTimes(1);
    },
  );
});
