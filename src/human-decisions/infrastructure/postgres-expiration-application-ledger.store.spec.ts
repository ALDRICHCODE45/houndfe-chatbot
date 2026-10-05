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

describe('offline EXPIRATION application ledger READ adapter', () => {
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

  it('throws on inconsistent driver results instead of reporting missing', async () => {
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
    }
  });

  it('propagates DB failures without rollback claims or a retry', async () => {
    const read = harness(new Error('read failed'));
    await expect(read.store.readByDecision(decisionId)).rejects.toThrow(
      'read failed',
    );
    expect(read.calls).toHaveLength(1);
  });
});
