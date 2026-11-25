import { CONVERSATION_GATE_KINDS } from '../domain/conversation-gate.store';

type Pgm = {
  dropConstraint: (...args: unknown[]) => void;
  addConstraint: (...args: unknown[]) => void;
  sql: (sql: string) => void;
};
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require('../../../migrations/5500000000000_conversation_gate_backorder_offer') as {
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

describe('conversation gate backorder kinds migration (5500)', () => {
  it('the code list carries both backorder kinds', () => {
    expect(CONVERSATION_GATE_KINDS).toEqual(
      expect.arrayContaining(['backorder_offer', 'backorder_quantity']),
    );
  });

  it('up re-creates the kind CHECK with exactly the kinds known at 5500', () => {
    // 5800 widens the code list with pet_choice (own spec).
    const known = CONVERSATION_GATE_KINDS.filter(
      (kind) => kind !== 'pet_choice',
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

  it('down refuses while an unexpired backorder row exists, then restores the 5400 CHECK', () => {
    const calls = run('down');
    const sql = calls
      .filter(([kind]) => kind === 'sql')
      .map(([, s]) => String(s));
    expect(sql[0]).toMatch(/LOCK TABLE conversation_gates/);
    expect(sql[1]).toMatch(
      /gate_kind IN \('backorder_offer', 'backorder_quantity'\) AND expires_at > now\(\)[\s\S]*RAISE EXCEPTION/,
    );
    expect(sql[2]).toMatch(
      /DELETE FROM conversation_gates WHERE gate_kind IN \('backorder_offer', 'backorder_quantity'\)/,
    );
    const add = calls.find(([kind]) => kind === 'add')!;
    expect(String(add[3])).not.toContain('backorder');
    expect(String(add[3])).toContain("'payment_offer'");
  });
});
