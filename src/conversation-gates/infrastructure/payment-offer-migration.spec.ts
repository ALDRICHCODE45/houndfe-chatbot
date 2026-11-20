import { CONVERSATION_GATE_KINDS } from '../domain/conversation-gate.store';

type Pgm = {
  dropConstraint: (...args: unknown[]) => void;
  addConstraint: (...args: unknown[]) => void;
  sql: (sql: string) => void;
};
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require('../../../migrations/5400000000000_conversation_gate_payment_offer') as {
    up: (pgm: Pgm) => void;
    down: (pgm: Pgm) => void;
  };

function run(direction: 'up' | 'down') {
  const calls: Array<[string, ...unknown[]]> = [];
  migration[direction]({
    dropConstraint: (...args) => calls.push(['drop', ...args]),
    addConstraint: (...args) => calls.push(['add', ...args]),
    sql: (sql) => calls.push(['sql', sql]),
  });
  return calls;
}

describe('conversation gate payment_offer migration (5400)', () => {
  it('up re-creates the kind CHECK with exactly the kinds known at 5400', () => {
    // 5500 widens the code list with the backorder kinds (own spec).
    const known = CONVERSATION_GATE_KINDS.filter(
      (kind) => !kind.startsWith('backorder_'),
    );
    const [drop, add] = run('up');
    expect(drop).toEqual([
      'drop',
      'conversation_gates',
      'conversation_gates_gate_kind_check',
    ]);
    const check = String(add[3]);
    for (const kind of known) expect(check).toContain(`'${kind}'`);
    expect(check.match(/'/g)).toHaveLength(known.length * 2);
  });

  it('down refuses while an unexpired payment_offer exists, then restores the old CHECK', () => {
    const calls = run('down');
    const sql = calls
      .filter(([kind]) => kind === 'sql')
      .map(([, s]) => String(s));
    expect(sql[0]).toMatch(/LOCK TABLE conversation_gates/);
    expect(sql[1]).toMatch(
      /payment_offer' AND expires_at > now\(\)[\s\S]*RAISE EXCEPTION/,
    );
    expect(sql[2]).toMatch(
      /DELETE FROM conversation_gates WHERE gate_kind = 'payment_offer'/,
    );
    const add = calls.find(([kind]) => kind === 'add')!;
    expect(String(add[3])).not.toContain('payment_offer');
  });
});
