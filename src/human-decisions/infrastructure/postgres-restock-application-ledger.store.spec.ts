import type { Pool } from 'pg';
import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';

const sourceRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const decisionId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const pending = () => ({
  senderId: 'whatsapp:+5215500000001',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2 as const,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-25T11:00:00.000Z',
  state: 'PENDING_DELIVERY' as const,
});
const persisted = (row: Record<string, unknown> = pending(), patch = {}) => ({
  decision_id: decisionId.toLowerCase(),
  source_request_id: sourceRequestId,
  attempt_id: pending().attemptId,
  sender_id: row.senderId,
  branch_id: row.branchId,
  row_data: row,
  ack_receipt: null,
  ...patch,
});
const result = (...rows: unknown[]) => ({ rows, rowCount: rows.length });
const empty = result();
function harness(...replies: unknown[]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as Pool;
  return { store: new PostgresRestockApplicationLedgerStore(pool), calls };
}
const hold = { action: 'hold' };

describe('offline restock application INSERT/READ adapter', () => {
  it('reads semantic UUID keys but retains the original payload bytes in a detached frozen snapshot', async () => {
    const raw = pending();
    const h = harness(result(persisted(raw)));
    const found = await h.store.readByDecision(decisionId);
    expect(found).toEqual({ action: 'found', row: raw, ack: null });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].sql).toMatch(
      /SELECT .* FROM restock_application_ledger WHERE decision_id = \$1/is,
    );
    expect(h.calls[0].values).toEqual([decisionId]);
    if (found.action !== 'found') throw new Error('not found');
    expect(found.row).not.toBe(raw);
    expect(Object.isFrozen(found.row)).toBe(true);
    raw.branchId = 'mutated';
    expect(found.row.branchId).toBe(' branch ');
    expect(found.row.decisionId).toBe(decisionId);
  });

  it('distinguishes missing from corrupt stored identity, row, or ACK', async () => {
    expect(await harness(empty).store.readByDecision(decisionId)).toEqual({
      action: 'missing',
    });
    for (const corrupted of [
      persisted(pending(), { branch_id: 'branch' }),
      persisted(pending(), { decision_id: sourceRequestId }),
      persisted(pending(), { source_request_id: undefined }),
      persisted({ ...pending(), applyBefore: 'bad' }),
      persisted(pending(), { ack_receipt: undefined }),
      persisted(pending(), { ack_receipt: { id: decisionId } }),
    ]) {
      expect(
        await harness(result(corrupted)).store.readByDecision(decisionId),
      ).toEqual(hold);
    }
  });

  it('returns a validated detached terminal ACK, not raw driver fields', async () => {
    const row = {
      ...pending(),
      state: 'STALE',
      staleObservedAt: pending().applyBefore,
    };
    const receipt = {
      id: decisionId.toLowerCase(),
      version: 2,
      attemptId: row.attemptId.toUpperCase(),
      outcome: 'STALE',
      ackReceivedAt: '2020-01-01T00:00:00Z',
    };
    const h = harness(
      result(persisted(row, { ack_receipt: receipt, secret: true })),
    );
    const found = await h.store.readByDecision(decisionId);
    expect(found).toEqual({ action: 'found', row, ack: receipt });
    expect(found).not.toHaveProperty('secret');
    if (found.action !== 'found') throw new Error('not found');
    expect(found.ack).not.toBe(receipt);
    expect(Object.isFrozen(found.ack)).toBe(true);
    receipt.ackReceivedAt = 'changed';
    expect(found.ack?.ackReceivedAt).toBe('2020-01-01T00:00:00Z');
    for (const bad of [
      { ...receipt, ackReceivedAt: 'bad' },
      { ...receipt, outcome: 'PROVIDER_ACCEPTED' },
      { ...receipt, id: sourceRequestId },
    ]) {
      expect(
        await harness(
          result(persisted(row, { ack_receipt: bad })),
        ).store.readByDecision(decisionId),
      ).toEqual(hold);
    }
  });

  it('rejects invalid input before querying', async () => {
    const h = harness();
    for (const bad of ['bad', undefined, null, {}, ' ']) {
      expect(await h.store.readByDecision(bad as never)).toEqual(hold);
    }
    for (const bad of [
      null,
      {},
      { ...pending(), branchId: '' },
      { ...pending(), state: 'SEND_STARTED' },
    ]) {
      expect(await h.store.insertPending(bad as never)).toEqual(hold);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('inserts exactly pending with SQL NULL ACK and returns detached validated data', async () => {
    const row = pending();
    const h = harness(result(persisted(row)));
    const inserted = await h.store.insertPending(row);
    expect(inserted).toEqual({ action: 'inserted', row });
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call.sql).toMatch(
      /INSERT INTO restock_application_ledger\s*\(decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data, ack_receipt\)/,
    );
    expect(call.sql).toMatch(
      /VALUES\s*\(\$1, \$2, \$3, \$4, \$5, \$6::jsonb, NULL\)/,
    );
    expect(call.sql).toMatch(/ON CONFLICT DO NOTHING RETURNING/);
    expect(call.values).toEqual([
      decisionId,
      sourceRequestId,
      row.attemptId,
      row.senderId,
      row.branchId,
      JSON.stringify(row),
    ]);
    if (inserted.action !== 'inserted') throw new Error('not inserted');
    expect(inserted.row).not.toBe(row);
    expect(Object.isFrozen(inserted.row)).toBe(true);
    row.branchId = 'changed';
    expect(inserted.row.branchId).toBe(' branch ');
  });

  it('replays only an exact full pending row with absent ACK after one conflict read', async () => {
    const row = pending();
    const h = harness(empty, result(persisted(row)));
    expect(await h.store.insertPending(row)).toEqual({ action: 'replay', row });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].sql).toContain('SELECT');
    expect(h.calls[1].values).toEqual([decisionId]);
    const changed = [
      { ...row, branchId: 'other' },
      { ...row, senderId: 'different' },
      {
        ...row,
        sourceRequestId: sourceRequestId.toUpperCase(),
        attemptId: deriveRestockAttemptId(
          sourceRequestId.toUpperCase(),
          decisionId,
        ),
      },
      { ...row, decisionId: decisionId.toLowerCase() },
      {
        ...row,
        resolvedAt: '2026-09-25T10:01:00.000Z',
        applyBefore: '2026-09-25T11:01:00.000Z',
      },
      { ...row, state: 'STALE', staleObservedAt: row.applyBefore },
    ];
    for (const other of changed) {
      expect(
        await harness(empty, result(persisted(other))).store.insertPending(row),
      ).toEqual(hold);
    }
    expect(await harness(empty, empty).store.insertPending(row)).toEqual(hold);
    expect(
      await harness(
        empty,
        result(persisted(row, { ack_receipt: undefined })),
      ).store.insertPending(row),
    ).toEqual(hold);
  });

  it('never turns malformed counts or DB failures into success or a retry', async () => {
    for (const bad of [
      { rows: [], rowCount: 1 },
      result(persisted(), persisted()),
      undefined,
    ]) {
      await expect(
        harness(bad).store.readByDecision(decisionId),
      ).rejects.toThrow();
      await expect(
        harness(bad).store.insertPending(pending()),
      ).rejects.toThrow();
      await expect(
        harness(empty, bad).store.insertPending(pending()),
      ).rejects.toThrow();
    }
    for (const replies of [
      [new Error('write failed')],
      [empty, new Error('read failed')],
    ]) {
      const h = harness(...replies);
      await expect(h.store.insertPending(pending())).rejects.toThrow(/failed/);
      expect(h.calls).toHaveLength(replies.length);
    }
    const h = harness(new Error('read failed'));
    await expect(h.store.readByDecision(decisionId)).rejects.toThrow(
      'read failed',
    );
    expect(h.calls).toHaveLength(1);
  });
});
