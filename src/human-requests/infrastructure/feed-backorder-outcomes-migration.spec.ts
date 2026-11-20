import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Pgm = {
  addColumn: (...args: unknown[]) => void;
  dropColumn: (...args: unknown[]) => void;
  dropConstraint: (...args: unknown[]) => void;
  addConstraint: (...args: unknown[]) => void;
  sql: (sql: string) => void;
};
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require('../../../migrations/5600000000000_feed_backorder_outcomes') as {
    up: (pgm: Pgm) => void;
    down: (pgm: Pgm) => void;
  };

function run(direction: 'up' | 'down') {
  const calls: Array<[string, ...unknown[]]> = [];
  migration[direction]({
    addColumn: (...args) => calls.push(['addColumn', ...args]),
    dropColumn: (...args) => calls.push(['dropColumn', ...args]),
    dropConstraint: (...args) => calls.push(['drop', ...args]),
    addConstraint: (...args) => calls.push(['add', ...args]),
    sql: (sql) => calls.push(['sql', sql]),
  });
  return calls;
}

const quotedValues = (check: string): string[] =>
  [...check.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);

/** The `DeliveryDecision` union of the ledger domain, read from source. */
const codeDecisions = (): string[] => {
  const source = readFileSync(
    join(__dirname, '..', 'domain', 'human-request-feed.ts'),
    'utf8',
  );
  const start = source.indexOf('export type DeliveryDecision =');
  const end = source.indexOf('export type AckState');
  return quotedValues(source.slice(start, end));
};

const DELIVERIES = 'human_request_deliveries';

describe('feed backorder outcomes migration (5600)', () => {
  it('up adds a nullable ack_reason column', () => {
    const [column] = run('up');
    expect(column).toEqual([
      'addColumn',
      DELIVERIES,
      { ack_reason: { type: 'text' } },
    ]);
  });

  it('up widens the decision CHECK to exactly the decisions of the code', () => {
    const add = run('up').find(
      (call) => call[0] === 'add' && call[2] === `${DELIVERIES}_decision_check`,
    )!;
    const migrated = quotedValues(String(add[3]));
    expect([...migrated].sort()).toEqual([...codeDecisions()].sort());
    expect(migrated).toEqual(
      expect.arrayContaining([
        'BACKORDER_RESERVED_NOTICE',
        'BACKORDER_REMINDER_NOTICE',
        'BACKORDER_EXPIRED_NOTICE',
        'BACKORDER_LOST_NOTICE',
        'BACKORDER_CANCELLED_NOTICE',
        'BACKORDER_ETA_PENDING',
        'BACKORDER_PAYLOAD_INVALID',
        'BACKORDER_OVERTAKEN',
        'TEMPLATE_NOT_APPROVED',
        // Reused, never dropped.
        'HUMAN_SESSION',
        'WINDOW_CLOSED',
        'NO_CONVERSATION',
        'SEND_REFUSED',
        'UNKNOWN_TYPE',
        'PICKUP_EXPIRED_REVIEW_NOTICE',
      ]),
    );
    expect(migrated.length).toBe(new Set(migrated).size);
  });

  it('up widens the ack_outcome CHECK with PROVIDER_REJECTED, keeping the rest', () => {
    const calls = run('up');
    const dropped = calls.filter((call) => call[0] === 'drop');
    expect(dropped.map((call) => call[2])).toEqual([
      `${DELIVERIES}_decision_check`,
      `${DELIVERIES}_ack_outcome_check`,
    ]);
    const add = calls.find(
      (call) =>
        call[0] === 'add' && call[2] === `${DELIVERIES}_ack_outcome_check`,
    )!;
    expect(quotedValues(String(add[3]))).toEqual([
      'PROVIDER_ACCEPTED',
      'DELIVERY_UNKNOWN',
      'DEFERRED_WINDOW_CLOSED',
      'DEFERRED_HUMAN_SESSION',
      'STALE',
      'PROVIDER_REJECTED',
    ]);
  });

  it('up ties the reason to PROVIDER_REJECTED (required there, forbidden elsewhere, 1-280)', () => {
    const add = run('up').find(
      (call) =>
        call[0] === 'add' && call[2] === `${DELIVERIES}_ack_reason_check`,
    )!;
    const check = String(add[3]);
    expect(check).toMatch(/ack_outcome IS DISTINCT FROM 'PROVIDER_REJECTED'/);
    expect(check).toMatch(/ack_reason IS NULL/);
    expect(check).toMatch(/ack_reason IS NOT NULL/);
    expect(check).toMatch(/char_length\(ack_reason\) BETWEEN 1 AND 280/);
  });

  it('down locks the ledger and refuses while a new decision or outcome is in use', () => {
    const calls = run('down');
    const sql = calls
      .filter((call) => call[0] === 'sql')
      .map((call) => String(call[1]));
    expect(sql[0]).toMatch(/LOCK TABLE human_request_deliveries/);
    expect(sql[1]).toMatch(/BACKORDER_RESERVED_NOTICE/);
    expect(sql[1]).toMatch(/ack_outcome IN \('PROVIDER_REJECTED'\)/);
    expect(sql[1]).toMatch(/RAISE EXCEPTION 'refusing to roll back/);
  });

  it('down restores the 5300 CHECKs and drops the column last', () => {
    const calls = run('down');
    const decision = calls.find(
      (call) => call[0] === 'add' && call[2] === `${DELIVERIES}_decision_check`,
    )!;
    expect(String(decision[3])).not.toMatch(/BACKORDER|TEMPLATE_NOT_APPROVED/);
    expect(String(decision[3])).toContain("'PICKUP_EXPIRED_REVIEW_NOTICE'");
    const outcome = calls.find(
      (call) =>
        call[0] === 'add' && call[2] === `${DELIVERIES}_ack_outcome_check`,
    )!;
    expect(String(outcome[3])).not.toContain('PROVIDER_REJECTED');
    expect(calls[calls.length - 1]).toEqual([
      'dropColumn',
      DELIVERIES,
      'ack_reason',
    ]);
    // The reason CHECK goes before the column it reads.
    expect(
      calls.findIndex(
        (call) =>
          call[0] === 'drop' && call[2] === `${DELIVERIES}_ack_reason_check`,
      ),
    ).toBeGreaterThan(-1);
  });
});
