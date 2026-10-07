import { normalizeCustomerInboundObservation } from '../domain/customer-inbound-observation';
import { PostgresCustomerInboundObservationStore } from './postgres-customer-inbound-observation.store';

// Mocked SQL only: query intent, bindings and outcomes, never real ordering or
// concurrency (T4 owns the PostgreSQL proof).
const base = {
  senderId: 'sender-1',
  receivingPhoneNumberId: '123456789',
  messageId: 'wamid.message-1',
  providerTimestampSeconds: '1700000000',
  observedAt: '2023-11-14T22:15:00.000Z',
};
function fixture(over: Record<string, unknown> = {}) {
  const record = normalizeCustomerInboundObservation({ ...base, ...over });
  expect(record).not.toBeNull();
  return record!;
}
const result = (...rows: unknown[]) => ({ rows, rowCount: rows.length });
const setup = () => {
  const query = jest.fn();
  return {
    query,
    store: new PostgresCustomerInboundObservationStore({ query }),
  };
};
const immutable = [
  'senderId',
  'receivingPhoneNumberId',
  'messageId',
  'providerTimestampSeconds',
] as const;
const drift: Record<string, string> = {
  senderId: 'other-sender',
  receivingPhoneNumberId: '987654321',
  messageId: 'wamid.other',
  providerTimestampSeconds: '1700000001',
  observedAt: '2023-11-14T22:16:00.000Z',
};
const malformed: unknown[] = [
  null,
  {},
  { senderId: 'only' },
  { ...base, extra: 1 },
  { ...base, providerTimestampSeconds: 1700000000 },
];

describe('standalone customer inbound observation adapter (mocked SQL)', () => {
  it('inserts five fields, detaches input/row and freezes output', async () => {
    const { query, store } = setup();
    const input = { ...fixture() };
    const returned = { ...fixture() };
    query.mockResolvedValue(result(returned));
    const pending = store.record(input);
    input.messageId = 'mutated';
    input.observedAt = '2024-01-01T00:00:00.000Z';
    const saved = await pending;
    returned.senderId = 'mutated';
    returned.observedAt = '2024-01-01T00:00:00.000Z';
    expect(saved).toEqual({ kind: 'recorded', observation: fixture() });
    expect(Object.isFrozen(saved)).toBe(true);
    if (saved.kind !== 'hold')
      expect(Object.isFrozen(saved.observation)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO customer_inbound_observations');
    expect(sql).toContain(
      'ON CONFLICT (receiving_phone_number_id, message_id) DO NOTHING',
    );
    expect(sql).toContain('provider_timestamp_seconds::text');
    expect(sql).not.toMatch(/UPDATE|DELETE|now\(/i);
    expect(params).toEqual([
      '123456789',
      'sender-1',
      'wamid.message-1',
      '1700000000',
      '2023-11-14T22:15:00.000Z',
    ]);
  });

  it.each([
    '2023-11-14T22:14:00.000Z',
    '2023-11-14T22:15:00.000Z',
    '2023-11-14T22:16:00.000Z',
  ])(
    'replays one event-key read preserving the first stored at %s',
    async (observedAt) => {
      const { query, store } = setup();
      query
        .mockResolvedValueOnce(result())
        .mockResolvedValueOnce(result(fixture()));
      expect(await store.record(fixture({ observedAt }))).toEqual({
        kind: 'replay',
        observation: fixture(),
      });
      expect(query).toHaveBeenCalledTimes(2);
      const [sql, params] = query.mock.calls[1] as [string, unknown[]];
      expect(sql).toContain(
        'WHERE receiving_phone_number_id = $1 AND message_id = $2',
      );
      expect(sql).not.toContain('ORDER BY');
      expect(params).toEqual(['123456789', 'wamid.message-1']);
    },
  );

  it.each(Object.keys(drift))('holds INSERT drift in %s', async (field) => {
    const { query, store } = setup();
    query.mockResolvedValue(result(fixture({ [field]: drift[field] })));
    expect(await store.record(fixture())).toEqual({ kind: 'hold' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(immutable)('holds stored replay drift in %s', async (field) => {
    const { query, store } = setup();
    query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(fixture({ [field]: drift[field] })));
    expect(await store.record(fixture())).toEqual({ kind: 'hold' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('holds malformed projections and absent or malformed replay reads', async () => {
    for (const raw of malformed) {
      const { query, store } = setup();
      query.mockResolvedValue(result(raw));
      expect(await store.record(fixture())).toEqual({ kind: 'hold' });
      expect(query).toHaveBeenCalledTimes(1);
      query.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(raw));
      expect(await store.record(fixture())).toEqual({ kind: 'hold' });
      expect(query).toHaveBeenCalledTimes(3);
    }
    const absent = setup();
    absent.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());
    expect(await absent.store.record(fixture())).toEqual({ kind: 'hold' });
    expect(absent.query).toHaveBeenCalledTimes(2);
  });

  it('reads numeric latest or missing/hold for the exact sender and phone', async () => {
    const { query, store } = setup();
    const returned = { ...fixture() };
    query.mockResolvedValue(result(returned));
    const found = await store.readLatest('sender-1', '123456789');
    returned.senderId = 'mutated';
    expect(found).toEqual({ kind: 'found', observation: fixture() });
    expect(Object.isFrozen(found)).toBe(true);
    if (found.kind === 'found')
      expect(Object.isFrozen(found.observation)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM customer_inbound_observations');
    expect(sql).toContain(
      'WHERE sender_id = $1 AND receiving_phone_number_id = $2',
    );
    expect(sql).toContain(
      'ORDER BY provider_timestamp_seconds DESC, message_id DESC LIMIT 1',
    );
    expect(sql).not.toContain('ORDER BY "providerTimestampSeconds"');
    expect(sql).not.toContain('ORDER BY provider_timestamp_seconds::text');
    expect(sql).not.toMatch(/UPDATE|DELETE|now\(/i);
    expect(params).toEqual(['sender-1', '123456789']);
    const empty = setup();
    empty.query.mockResolvedValue(result());
    expect(await empty.store.readLatest('sender-1', '123456789')).toEqual({
      kind: 'missing',
    });
    for (const raw of [
      null,
      {},
      { ...base, extra: 1 },
      fixture({ senderId: 'other-sender' }),
      fixture({ receivingPhoneNumberId: '987654321' }),
    ]) {
      const held = setup();
      held.query.mockResolvedValue(result(raw));
      expect(await held.store.readLatest('sender-1', '123456789')).toEqual({
        kind: 'hold',
      });
      expect(held.query).toHaveBeenCalledTimes(1);
    }
  });

  it('holds invalid record and lookup input before any I/O at the boundaries', async () => {
    const { query, store } = setup();
    const valid = fixture();
    const { messageId: omitted, ...missing } = valid;
    expect(omitted).toBe('wamid.message-1');
    for (const raw of [
      null,
      undefined,
      42,
      'row',
      [],
      missing,
      { ...valid, extra: true },
      { ...valid, providerTimestampSeconds: 1700000000 },
      { ...valid, observedAt: '2023-11-14T22:13:19.000Z' },
      { ...valid, receivingPhoneNumberId: '12x' },
      { ...valid, senderId: 'bad\u0000' },
    ])
      expect(await store.record(raw)).toEqual({ kind: 'hold' });
    const invalidKey: [unknown, unknown][] = [
      ['', '123'],
      [' ', '123'],
      [' x', '123'],
      ['x ', '123'],
      ['x'.repeat(201), '123'],
      ['a\u0000b', '123'],
      ['a\u0080b', '123'],
      [['x'], '123'],
      [null, '123'],
      ['sender-1', ''],
      ['sender-1', '12x'],
      ['sender-1', '1'.repeat(25)],
      ['sender-1', ' 1'],
      ['sender-1', ['1']],
      ['sender-1', undefined],
    ];
    for (const [senderId, phone] of invalidKey)
      expect(
        await store.readLatest(senderId as string, phone as string),
      ).toEqual({ kind: 'hold' });
    expect(query).not.toHaveBeenCalled();
    const edge = fixture({
      senderId: 'é'.repeat(200),
      receivingPhoneNumberId: '1'.repeat(24),
    });
    query.mockResolvedValue(result({ ...edge }));
    expect(await store.readLatest('é'.repeat(200), '1'.repeat(24))).toEqual({
      kind: 'found',
      observation: edge,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throws bounded generic errors for incoherent driver envelopes', async () => {
    const envelopes: unknown[] = [
      null,
      {},
      'row',
      { rows: [], rowCount: 1 },
      { rows: [fixture()], rowCount: 0 },
      { rows: [], rowCount: null },
      result(fixture(), fixture()),
    ];
    for (const raw of envelopes) {
      const { query, store } = setup();
      query.mockResolvedValue(raw);
      await expect(store.record(fixture())).rejects.toThrow(
        'observation result',
      );
      await expect(store.readLatest('sender-1', '123456789')).rejects.toThrow(
        'observation result',
      );
      query.mockResolvedValueOnce(result()).mockResolvedValueOnce(raw);
      await expect(store.record(fixture())).rejects.toThrow(
        'observation result',
      );
    }
  });

  it('propagates each query error once without retry or recovery', async () => {
    const error = new Error('database unavailable');
    const insert = setup();
    insert.query.mockRejectedValue(error);
    await expect(insert.store.record(fixture())).rejects.toBe(error);
    expect(insert.query).toHaveBeenCalledTimes(1);
    const latest = setup();
    latest.query.mockRejectedValue(error);
    await expect(latest.store.readLatest('sender-1', '123456789')).rejects.toBe(
      error,
    );
    expect(latest.query).toHaveBeenCalledTimes(1);
    const retry = setup();
    retry.query.mockResolvedValueOnce(result()).mockRejectedValueOnce(error);
    await expect(retry.store.record(fixture())).rejects.toBe(error);
    expect(retry.query).toHaveBeenCalledTimes(2);
  });
});
