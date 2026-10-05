import type { Pool } from 'pg';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';

const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const resolvedAt = '2026-09-25T10:00:00.000Z';
const applyBefore = '2026-09-26T10:00:00.000Z';
const attemptId = deriveExpirationAttemptId(sourceRequestId, decisionId)!;
const pending = () => ({
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2 as const,
  attemptId,
  resolvedAt,
  applyBefore,
  state: 'PENDING_DELIVERY' as const,
});
/** Columns track the row identity so corruption tests isolate one divergence. */
const persisted = (row: Record<string, unknown> = pending(), patch = {}) => ({
  decision_id: row.decisionId,
  source_request_id: row.sourceRequestId,
  attempt_id: row.attemptId,
  sender_id: row.senderId,
  branch_id: row.branchId,
  row_data: row,
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
  return { store: new PostgresExpirationApplicationLedgerStore(pool), calls };
}
const hold = { action: 'hold' };
const inserts = (calls: Array<{ sql: string }>) =>
  calls.filter((call) => call.sql.startsWith('INSERT'));

describe('offline EXPIRATION application INSERT/READ adapter', () => {
  it('reads a canonical decision as a detached frozen pending snapshot via one SELECT', async () => {
    const raw = pending();
    const h = harness(result(persisted(raw)));
    const found = await h.store.readByDecision(decisionId);
    expect(found).toEqual({ action: 'foundPending', row: raw });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].sql).toMatch(
      /SELECT .* FROM expiration_application_ledger WHERE decision_id = \$1/is,
    );
    expect(h.calls[0].sql).not.toContain('restock');
    expect(h.calls[0].values).toEqual([decisionId]);
    if (found.action !== 'foundPending') throw new Error('not found');
    expect(found.row).not.toBe(raw);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found.row)).toBe(true);
    expect(found).not.toHaveProperty('ack');
    expect(found.row).not.toHaveProperty('ack');
    raw.branchId = 'mutated';
    expect(found.row.branchId).toBe(' branch ');
  });

  it('distinguishes an absent row from a corrupt stored row or requested mismatch', async () => {
    expect(await harness(empty).store.readByDecision(decisionId)).toEqual({
      action: 'missing',
    });
    const corrupt = [
      persisted(pending(), { branch_id: 'branch' }),
      persisted(pending(), { sender_id: 'other' }),
      persisted(pending(), { decision_id: decisionId.toUpperCase() }),
      persisted(pending(), { source_request_id: undefined }),
      persisted(pending(), { attempt_id: sourceRequestId }),
      persisted({ ...pending(), applyBefore: 'bad' }),
      persisted({ ...pending(), state: 'STALE', staleObservedAt: applyBefore }),
      persisted(pending(), { decision_id: sourceRequestId }),
    ];
    for (const raw of corrupt) {
      expect(
        await harness(result(raw)).store.readByDecision(decisionId),
      ).toEqual(hold);
    }
  });

  it('holds a noncanonical decision key before querying', async () => {
    const h = harness();
    for (const bad of [
      decisionId.toUpperCase(),
      'bad',
      `${decisionId} `,
      `${decisionId}\n`,
      '',
      null,
      undefined,
      3,
    ]) {
      expect(await h.store.readByDecision(bad as never)).toEqual(hold);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('rejects invalid or not-yet-pending input before the first query', async () => {
    const h = harness();
    const bad = [
      null,
      {},
      { ...pending(), branchId: '' },
      { ...pending(), senderId: ' padded' },
      { ...pending(), decisionId: decisionId.toUpperCase() },
      { ...pending(), sourceRequestId: 'bad' },
      { ...pending(), attemptId: sourceRequestId },
      { ...pending(), resolutionVersion: 1 },
      { ...pending(), applyBefore: '2026-09-25T11:00:00.000Z' },
      {
        ...pending(),
        state: 'SEND_STARTED',
        sendToken: '33333333-3333-4333-8333-333333333333',
        attemptedAt: resolvedAt,
      },
      { ...pending(), state: 'STALE', staleObservedAt: applyBefore },
    ];
    for (const input of bad) {
      expect(await h.store.insertPending(input as never)).toEqual(hold);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('inserts one PENDING_DELIVERY row with canonical columns and frozen output', async () => {
    const row = pending();
    const h = harness(result(persisted(row)));
    const inserted = await h.store.insertPending(row);
    expect(inserted).toEqual({ action: 'inserted', row });
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call.sql).toMatch(
      /INSERT INTO expiration_application_ledger\s*\(decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data\)/,
    );
    expect(call.sql).toMatch(
      /VALUES\s*\(\$1, \$2, \$3, \$4, \$5, \$6::jsonb\)/,
    );
    expect(call.sql).toMatch(/ON CONFLICT DO NOTHING RETURNING/);
    expect(call.sql).not.toContain('restock');
    expect(call.values).toEqual([
      decisionId,
      sourceRequestId,
      attemptId,
      row.senderId,
      row.branchId,
      JSON.stringify(row),
    ]);
    if (inserted.action !== 'inserted') throw new Error('not inserted');
    expect(inserted.row).not.toBe(row);
    expect(Object.isFrozen(inserted)).toBe(true);
    expect(Object.isFrozen(inserted.row)).toBe(true);
    expect(inserted).not.toHaveProperty('ack');
    row.branchId = 'changed';
    expect(inserted.row.branchId).toBe(' branch ');
    expect(
      await harness(
        result(persisted(row, { sender_id: 'x' })),
      ).store.insertPending(pending()),
    ).toEqual(hold);
    expect(
      await harness(
        result(persisted({ ...pending(), branchId: 'other' })),
      ).store.insertPending(pending()),
    ).toEqual(hold);
  });

  it('replays only an exact full pending row after exactly one conflict read', async () => {
    const row = pending();
    const h = harness(empty, result(persisted(row)));
    expect(await h.store.insertPending(row)).toEqual({ action: 'replay', row });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].sql).toContain('SELECT');
    expect(h.calls[1].values).toEqual([decisionId]);
    expect(inserts(h.calls)).toHaveLength(1);
    const movedSource = sourceRequestId.replace('848d', '9999');
    const changed = [
      { ...row, branchId: 'other' },
      { ...row, senderId: 'different' },
      {
        ...row,
        sourceRequestId: movedSource,
        attemptId: deriveExpirationAttemptId(movedSource, decisionId)!,
      },
      {
        ...row,
        resolvedAt: '2026-09-25T10:01:00.000Z',
        applyBefore: '2026-09-26T10:01:00.000Z',
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
        result(persisted(row, { sender_id: 'x' })),
      ).store.insertPending(row),
    ).toEqual(hold);
  });

  it('throws on inconsistent driver results instead of reporting missing or retrying', async () => {
    const malformed = [
      { rows: [], rowCount: 1 },
      result(persisted(), persisted()),
      undefined,
      result(null),
    ];
    for (const bad of malformed) {
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
  });

  it('propagates DB failures without rollback claims, retries or a second write', async () => {
    const read = harness(new Error('read failed'));
    await expect(read.store.readByDecision(decisionId)).rejects.toThrow(
      'read failed',
    );
    expect(read.calls).toHaveLength(1);
    const write = harness(new Error('write failed'));
    await expect(write.store.insertPending(pending())).rejects.toThrow(
      'write failed',
    );
    expect(write.calls).toHaveLength(1);
    const conflict = harness(empty, new Error('read failed'));
    await expect(conflict.store.insertPending(pending())).rejects.toThrow(
      'read failed',
    );
    expect(conflict.calls).toHaveLength(2);
    expect(inserts(conflict.calls)).toHaveLength(1);
  });

  it('serializes the validated snapshot before the first await', async () => {
    const row = pending();
    const calls: unknown[][] = [];
    const store = new PostgresExpirationApplicationLedgerStore({
      query: async (_sql: string, values: unknown[]) => {
        calls.push(values);
        row.branchId = 'mutated during await';
        row.senderId = 'mutated';
        return result(persisted(pending()));
      },
    } as unknown as Pick<Pool, 'query'>);
    const inserted = await store.insertPending(row);
    expect(calls[0]).toEqual([
      decisionId,
      sourceRequestId,
      attemptId,
      'customer',
      ' branch ',
      JSON.stringify(pending()),
    ]);
    expect(inserted).toEqual({ action: 'inserted', row: pending() });
  });
});
