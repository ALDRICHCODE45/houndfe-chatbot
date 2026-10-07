import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

// Real disposable PostgreSQL16 only: no domain/port import (T1 owns that) and
// no ambient DATABASE_URL. This proves schema structure, never store behavior.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const TABLE = 'customer_inbound_observations';
const LATEST_INDEX = `${TABLE}_latest_idx`;
const MIGRATION = '3100000000000';
const columns = [
  'receiving_phone_number_id',
  'sender_id',
  'message_id',
  'provider_timestamp_seconds',
  'observed_at',
] as const;
type Column = (typeof columns)[number];
type Row = Record<Column, string | null>;
// Module-level allowlisted identifiers: TABLE/columns are compile-time constants.
const SELECT_ROWS = `SELECT * FROM ${TABLE}`;
const INSERT_ROW = `INSERT INTO ${TABLE} (${columns.join(', ')})
VALUES ($1, $2, $3, $4, $5)`;
const TRUNCATE_ROWS = `TRUNCATE TABLE ${TABLE}`;
const base: Row = {
  receiving_phone_number_id: '123456789',
  sender_id: 'Sender:Á🙂',
  message_id: 'wamid:MiXeD:é🙂',
  provider_timestamp_seconds: '1782086400',
  observed_at: '2026-06-22T01:02:03.004Z',
};
const fixture = (patch: Partial<Row> = {}): Row => ({ ...base, ...patch });

ddescribe(
  'customer inbound observations migration 310 (real PostgreSQL)',
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
    const insert = (patch: Partial<Row> = {}) => {
      const row = fixture(patch);
      return pool.query(
        INSERT_ROW,
        columns.map((column) => row[column]),
      );
    };
    const rows = async () => (await pool.query<Row>(SELECT_ROWS)).rows;
    const rejected = (column: Column, value: Row[Column], check: string) =>
      expect(insert({ [column]: value })).rejects.toMatchObject({
        code: '23514',
        constraint: `${TABLE}_${check}_check`,
      });

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      uri = container.getConnectionUri();
      migrate('up', '3000000000000', '--timestamp');
      pool = new Pool({ connectionString: uri });
      await pool.query(
        `INSERT INTO human_handoff_requests (id, customer_id, agent_id, kind, digest)
       VALUES ('sentinel', 'customer', 'agent', 'restock', '{}'::jsonb)`,
      );
      migrate('up', MIGRATION, '--timestamp');
    });
    afterAll(async () => {
      try {
        if (pool) await pool.end();
      } finally {
        if (container) await container.stop();
      }
    });
    beforeEach(async () => {
      await pool.query(TRUNCATE_ROWS);
    });

    it('has exactly the five NOT NULL columns with C collation and no defaults', async () => {
      const schema = await pool.query<{
        column_name: string;
        data_type: string;
        not_null: boolean;
        column_default: string | null;
        collation: string | null;
      }>(
        `SELECT a.attname AS column_name,
                format_type(a.atttypid, NULL) AS data_type,
                a.attnotnull AS not_null,
                pg_get_expr(d.adbin, d.adrelid) AS column_default,
                c.collname AS collation
         FROM pg_attribute a
         JOIN pg_class r ON r.oid = a.attrelid
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_collation c ON c.oid = a.attcollation
         WHERE r.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [TABLE],
      );
      expect(
        schema.rows.map((row) => [
          row.column_name,
          row.data_type,
          row.not_null,
          row.column_default,
          row.collation,
        ]),
      ).toEqual([
        ['receiving_phone_number_id', 'text', true, null, 'C'],
        ['sender_id', 'text', true, null, 'C'],
        ['message_id', 'text', true, null, 'C'],
        ['provider_timestamp_seconds', 'bigint', true, null, null],
        ['observed_at', 'text', true, null, 'default'],
      ]);
    });

    it.each(columns)('rejects SQL NULL in %s independently', async (column) => {
      await expect(insert({ [column]: null })).rejects.toMatchObject({
        code: '23502',
        table: TABLE,
        column,
      });
    });

    it('keys (phone,message) not sender: conflicts AND reuse elsewhere', async () => {
      await insert();
      await expect(insert()).rejects.toMatchObject({
        code: '23505',
        constraint: `${TABLE}_pkey`,
      });
      // Same (phone,message) with a different sender still collides.
      await expect(insert({ sender_id: 'other' })).rejects.toMatchObject({
        code: '23505',
        constraint: `${TABLE}_pkey`,
      });
      // Same message on another phone, and other messages elsewhere, coexist.
      for (const patch of [
        { receiving_phone_number_id: '987654321' },
        { message_id: 'wamid:other' },
        { message_id: 'wamid:third', sender_id: 'other' },
      ])
        await insert(patch);
      expect(await rows()).toHaveLength(4);
    });

    it.each(['', '12x', '1'.repeat(25), ' 1', '1\n'])(
      'rejects invalid phone %j',
      async (phone) => {
        await rejected('receiving_phone_number_id', phone, 'phone');
      },
    );

    it.each([
      ['sender_id', 200],
      ['message_id', 512],
    ] as const)(
      'checks %s opaque bounds, blanks and outer spaces',
      async (column, max) => {
        for (const value of [
          '',
          ' ',
          '  ',
          ' leading',
          'trailing ',
          'x'.repeat(max + 1),
        ])
          await rejected(column, value, column);
      },
    );

    it.each(['0', '-1', '8640000000001'])(
      'rejects out-of-range provider seconds %s',
      async (seconds) => {
        await rejected(
          'provider_timestamp_seconds',
          seconds,
          'provider_seconds',
        );
      },
    );

    it.each(['1', '8640000000000'])(
      'accepts provider second boundary %s',
      async (seconds) => {
        await insert({ provider_timestamp_seconds: seconds });
        expect(await rows()).toEqual([
          fixture({ provider_timestamp_seconds: seconds }),
        ]);
      },
    );

    it.each(['abc', '1.5', ''])(
      'rejects malformed provider literal %j at cast, not a CHECK',
      async (raw) => {
        await expect(
          insert({ provider_timestamp_seconds: raw }),
        ).rejects.toMatchObject({ code: '22P02' });
      },
    );

    it.each([
      '',
      ' ',
      '2026-06-22T01:02:03.004+00:00',
      '2026-06-22T01:02:03Z',
      '2026-06-22T01:02:03.004Z\n',
    ])('rejects observedAt shape %j', async (observedAt) => {
      await rejected('observed_at', observedAt, 'observed_at');
    });

    it('preserves original coordinate and observation spelling byte for byte', async () => {
      await insert();
      expect(await rows()).toEqual([fixture()]);
    });

    it('creates the latest composite index in the required order', async () => {
      const index = await pool.query<{ indexdef: string }>(
        'SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
        ['public', LATEST_INDEX],
      );
      expect(index.rows).toEqual([
        {
          indexdef: `CREATE INDEX ${LATEST_INDEX} ON public.${TABLE} USING btree (receiving_phone_number_id, sender_id, provider_timestamp_seconds DESC, message_id DESC)`,
        },
      ]);
    });

    it('orders provider seconds numerically, not lexically', async () => {
      for (const seconds of ['9', '100', '10'])
        await insert({
          provider_timestamp_seconds: seconds,
          message_id: `m-${seconds}`,
        });
      const ordered = await pool.query<{ provider_timestamp_seconds: string }>(
        `SELECT provider_timestamp_seconds FROM ${TABLE}
       ORDER BY provider_timestamp_seconds DESC`,
      );
      expect(ordered.rows.map((row) => row.provider_timestamp_seconds)).toEqual(
        ['100', '10', '9'],
      );
    });

    it('bounds structure only: SQL stores domain-invalid calendars and distinct case', async () => {
      await insert({ observed_at: '2026-99-99T99:99:99.999Z' });
      await insert({ message_id: 'MiXeD' });
      await insert({ message_id: 'mixed' });
      const stored = await rows();
      expect(stored).toHaveLength(3);
      expect(stored.map((row) => row.observed_at)).toContain(
        '2026-99-99T99:99:99.999Z',
      );
      expect(stored.map((row) => row.message_id)).toEqual(
        expect.arrayContaining(['MiXeD', 'mixed']),
      );
    });

    it('leaves prior migration data untouched (bounded sentinel)', async () => {
      const sentinel = await pool.query(
        `SELECT id, status, digest FROM human_handoff_requests
         WHERE id = 'sentinel'`,
      );
      expect(sentinel.rows).toEqual([
        { id: 'sentinel', status: 'pending', digest: {} },
      ]);
    });

    it('refuses down with any row, preserves evidence, drops empty and reapplies', async () => {
      await insert();
      expect(() => migrate('down')).toThrow(
        `refusing to roll back ${TABLE}: table is non-empty`,
      );
      expect(await rows()).toEqual([fixture()]);
      // The failed transactional rollback keeps the schema protections intact.
      await rejected('provider_timestamp_seconds', '0', 'provider_seconds');
      await pool.query(TRUNCATE_ROWS);
      try {
        migrate('down');
        const absent = await pool.query('SELECT to_regclass($1) AS name', [
          TABLE,
        ]);
        expect(absent.rows).toEqual([{ name: null }]);
      } finally {
        migrate('up', MIGRATION, '--timestamp');
      }
      expect(await rows()).toEqual([]);
      await insert();
      expect(await rows()).toEqual([fixture()]);
    });
  },
);
