import {
  bindRestockInboundEvidence,
  normalizeRestockInboundEvidence,
  type RestockInboundEvidence,
} from '../domain/restock-inbound-evidence';
import { PostgresRestockInboundEvidenceStore } from './postgres-restock-inbound-evidence.store';

const event = {
  receivingPhoneNumberId: '123',
  senderId: 'sender',
  messageId: 'message',
};
function fixture(overrides = {}): RestockInboundEvidence {
  const row = bindRestockInboundEvidence(
    {
      event,
      providerTimestampSeconds: '1700000000',
      observedAt: '2023-11-14T22:15:00.000Z',
      ...overrides,
    },
    '123',
  );
  expect(row).not.toBeNull();
  return row!;
}
const result = (...rows: unknown[]) => ({ rows, rowCount: rows.length });
function setup() {
  const query = jest.fn();
  const store = new PostgresRestockInboundEvidenceStore({
    query,
  });
  return { query, store };
}

describe('unwired inbound evidence persistence', () => {
  it('inserts seven bound values and returns detached frozen evidence', async () => {
    const { query, store } = setup();
    const input = { ...fixture() };
    const returned = { ...input };
    query.mockResolvedValue(result(returned));
    const pending = store.record(input);
    input.messageId = 'mutated';
    const saved = await pending;
    expect(saved).toEqual({ action: 'recorded', evidence: fixture() });
    returned.messageId = 'also mutated';
    expect(saved).toEqual({ action: 'recorded', evidence: fixture() });
    expect(Object.isFrozen(saved)).toBe(true);
    if (saved.action !== 'hold')
      expect(Object.isFrozen(saved.evidence)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO restock_inbound_evidence');
    expect(sql).toContain('ON CONFLICT DO NOTHING RETURNING');
    expect(sql).not.toMatch(/UPDATE|DELETE|now\(/i);
    expect(params).toEqual([
      fixture().sourceRequestId,
      '123',
      'sender',
      'message',
      '1700000000',
      '2023-11-14T22:15:00.000Z',
      1,
    ]);
  });

  it.each([
    '2023-11-14T22:15:00.000Z',
    '2023-11-14T22:16:00.000Z',
    '2023-11-14T22:14:00.000Z',
  ])('replays first persisted observation against %s', async (observedAt) => {
    const { query, store } = setup();
    const input = fixture({ observedAt });
    query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(fixture()));
    expect(await store.record(input)).toEqual({
      action: 'replay',
      evidence: fixture(),
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining('WHERE source_request_id = $1'),
      [input.sourceRequestId],
    ]);
  });

  it('reads a semantic uppercase UUID but returns canonical detached evidence', async () => {
    const { query, store } = setup();
    const raw = { ...fixture() };
    expect(raw.sourceRequestId).toMatch(/[a-f]/);
    query.mockResolvedValue(result(raw));
    const read = await store.readBySource(raw.sourceRequestId.toUpperCase());
    raw.observedAt = 'changed';
    expect(read).toEqual({ action: 'found', evidence: fixture() });
    expect(Object.isFrozen(read)).toBe(true);
    if (read.action === 'found')
      expect(Object.isFrozen(read.evidence)).toBe(true);
  });

  it('distinguishes missing read from missing conflict evidence', async () => {
    const { query, store } = setup();
    query.mockResolvedValue(result());
    expect(await store.readBySource(fixture().sourceRequestId)).toEqual({
      action: 'missing',
    });
    expect(await store.record(fixture())).toEqual({ action: 'hold' });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('holds valid immutable conflicts, including changed provider seconds', async () => {
    const alternatives = [
      fixture({ providerTimestampSeconds: '1700000001' }),
      fixture({ event: { ...event, senderId: 'other' } }),
      fixture({ event: { ...event, messageId: 'other' } }),
      bindRestockInboundEvidence(
        {
          event: { ...event, receivingPhoneNumberId: '456' },
          providerTimestampSeconds: '1700000000',
          observedAt: fixture().observedAt,
        },
        '456',
      ),
    ];
    for (const existing of alternatives) {
      expect(normalizeRestockInboundEvidence(existing)).not.toBeNull();
      const { query, store } = setup();
      query
        .mockResolvedValueOnce(result())
        .mockResolvedValueOnce(result(existing));
      expect(await store.record(fixture())).toEqual({ action: 'hold' });
      expect(query).toHaveBeenCalledTimes(2);
    }
  });

  it('holds malformed inputs before querying and corrupt projections on every path', async () => {
    const valid = fixture();
    const { messageId: omitted, ...missing } = valid;
    expect(omitted).toBe('message');
    const invalid: unknown[] = [
      null,
      {},
      missing,
      { ...valid, extra: true },
      { ...valid, version: '1' },
      { ...valid, version: 2 },
      { ...valid, sourceRequestId: valid.sourceRequestId.toUpperCase() },
      { ...valid, sourceRequestId: '00000000-0000-0000-0000-000000000000' },
      { ...valid, senderId: 'drift' },
      { ...valid, messageId: 'bad\u0000' },
      { ...valid, observedAt: '2023-11-14T22:00:00.000Z' },
      { ...valid, providerTimestampSeconds: 1700000000 },
    ];
    for (const raw of invalid) {
      expect(normalizeRestockInboundEvidence(raw)).toBeNull();
      const { query, store } = setup();
      expect(await store.record(raw as RestockInboundEvidence)).toEqual({
        action: 'hold',
      });
      expect(query).not.toHaveBeenCalled();
      query.mockResolvedValue(result(raw));
      expect(await store.readBySource(valid.sourceRequestId)).toEqual({
        action: 'hold',
      });
      expect(await store.record(valid)).toEqual({ action: 'hold' });
      query.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(raw));
      expect(await store.record(valid)).toEqual({ action: 'hold' });
    }
  });

  it('rejects invalid read IDs without querying', async () => {
    const { query, store } = setup();
    for (const id of ['', 'not-uuid', null, 1]) {
      expect(await store.readBySource(id as string)).toEqual({
        action: 'hold',
      });
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('holds a valid but different INSERT projection, including observation', async () => {
    for (const raw of [
      fixture({ observedAt: '2023-11-14T22:16:00.000Z' }),
      fixture({ providerTimestampSeconds: '1700000001' }),
    ]) {
      expect(normalizeRestockInboundEvidence(raw)).not.toBeNull();
      const { query, store } = setup();
      query.mockResolvedValue(result(raw));
      expect(await store.record(fixture())).toEqual({ action: 'hold' });
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it('throws bounded errors for inconsistent ordinary pg result cardinalities', async () => {
    for (const raw of [
      null,
      {},
      { rows: [], rowCount: 1 },
      { rows: [fixture()], rowCount: 0 },
      { rows: [], rowCount: null },
      result(fixture(), fixture()),
    ]) {
      const { query, store } = setup();
      query.mockResolvedValue(raw);
      await expect(store.record(fixture())).rejects.toThrow('evidence result');
      await expect(
        store.readBySource(fixture().sourceRequestId),
      ).rejects.toThrow('evidence result');
      query.mockResolvedValueOnce(result()).mockResolvedValueOnce(raw);
      await expect(store.record(fixture())).rejects.toThrow('evidence result');
    }
  });

  it('propagates insert/read errors without retry, including uncertain inserts', async () => {
    const error = new Error('database unavailable');
    const { query, store } = setup();
    query.mockRejectedValue(error);
    await expect(store.record(fixture())).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(store.readBySource(fixture().sourceRequestId)).rejects.toBe(
      error,
    );
    expect(query).toHaveBeenCalledTimes(2);
    query.mockResolvedValueOnce(result()).mockRejectedValueOnce(error);
    await expect(store.record(fixture())).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
