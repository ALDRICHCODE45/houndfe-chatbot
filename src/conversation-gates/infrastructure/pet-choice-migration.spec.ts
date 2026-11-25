import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { CONVERSATION_GATE_KINDS } from '../domain/conversation-gate.store';

type Pgm = {
  dropConstraint: (...args: unknown[]) => void;
  addConstraint: (...args: unknown[]) => void;
  sql: (sql: string) => void;
};
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require('../../../migrations/5800000000000_conversation_gate_pet_choice') as {
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

describe('conversation gate pet_choice migration (5800)', () => {
  it('the code list carries pet_choice', () => {
    expect(CONVERSATION_GATE_KINDS).toContain('pet_choice');
  });

  it('up re-creates the kind CHECK with exactly the code list', () => {
    const [drop, add] = run('up');
    expect(drop).toEqual([
      'drop',
      'conversation_gates',
      'conversation_gates_gate_kind_check',
    ]);
    const check = String(add[3]);
    for (const kind of CONVERSATION_GATE_KINDS)
      expect(check).toContain(`'${kind}'`);
    expect(check.match(/'/g)).toHaveLength(CONVERSATION_GATE_KINDS.length * 2);
  });

  it('down refuses while an unexpired pet_choice row exists, then restores the 5500 CHECK', () => {
    const calls = run('down');
    const sql = calls
      .filter(([kind]) => kind === 'sql')
      .map(([, s]) => String(s));
    expect(sql[0]).toMatch(/LOCK TABLE conversation_gates/);
    expect(sql[1]).toMatch(
      /gate_kind IN \('pet_choice'\) AND expires_at > now\(\)[\s\S]*RAISE EXCEPTION/,
    );
    expect(sql[2]).toMatch(
      /DELETE FROM conversation_gates WHERE gate_kind IN \('pet_choice'\)/,
    );
    const add = calls.find(([kind]) => kind === 'add')!;
    const check = String(add[3]);
    expect(check).not.toContain('pet_choice');
    const previous = CONVERSATION_GATE_KINDS.filter(
      (kind) => kind !== 'pet_choice',
    );
    for (const kind of previous) expect(check).toContain(`'${kind}'`);
    expect(check.match(/'/g)).toHaveLength(previous.length * 2);
  });
});

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');

ddescribe(
  'conversation gate pet_choice migration 5800 (real PostgreSQL)',
  () => {
    jest.setTimeout(180_000);
    let container: StartedPostgreSqlContainer | undefined;
    let pool: Pool;
    let uri: string;
    const migrate = (direction: 'up' | 'down', ...args: string[]) =>
      execFileSync(
        process.execPath,
        [
          BIN,
          '-f',
          'package.json',
          '--config-value',
          'pg-migrate',
          direction,
          ...args,
        ],
        {
          cwd: ROOT,
          env: { DATABASE_URL: uri },
          stdio: 'pipe',
          timeout: 60_000,
        },
      );
    const insertPetChoice = (minutes: number) =>
      pool.query(
        `INSERT INTO conversation_gates (sender_id, gate_kind, payload, expires_at)
       VALUES ('5215550001111', 'pet_choice', '{"purpose":"request"}'::jsonb,
               now() + make_interval(mins => $1))`,
        [minutes],
      );
    /** Roll back 5800 and anything applied after it. */
    const rollbackFrom5800 = async () => {
      const applied = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM pgmigrations
        WHERE name >= '5800000000000_conversation_gate_pet_choice'`,
      );
      migrate('down', applied.rows[0].n);
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      uri = container.getConnectionUri();
      migrate('up');
      pool = new Pool({ connectionString: uri, max: 4 });
    });

    afterAll(async () => {
      await pool?.end();
      await container?.stop();
    });

    it('accepts pet_choice; down refuses while one is unexpired, then drops expired ones and restores the CHECK', async () => {
      await insertPetChoice(15);
      await expect(rollbackFrom5800()).rejects.toThrow(
        /unexpired pet_choice gates exist/,
      );
      await pool.query(
        "UPDATE conversation_gates SET expires_at = now() - interval '1 minute' WHERE gate_kind = 'pet_choice'",
      );
      await rollbackFrom5800();
      const left = await pool.query(
        "SELECT count(*)::int AS n FROM conversation_gates WHERE gate_kind = 'pet_choice'",
      );
      expect(left.rows[0]).toEqual({ n: 0 });
      await expect(insertPetChoice(15)).rejects.toMatchObject({
        code: '23514',
      });
      migrate('up');
      await insertPetChoice(15);
    });
  },
);
