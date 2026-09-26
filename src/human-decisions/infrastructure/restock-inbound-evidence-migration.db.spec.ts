import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  bindRestockInboundEvidence,
  normalizeRestockInboundEvidence,
} from '../domain/restock-inbound-evidence';

/** Structural proof of committed migration 260, not retroactive RED. */
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const TABLE = 'restock_inbound_evidence';
const columns = [
  'source_request_id',
  'receiving_phone_number_id',
  'sender_id',
  'message_id',
  'provider_timestamp_seconds',
  'observed_at',
  'version',
] as const;
type Column = (typeof columns)[number];
type Row = Record<Column, string | number | null>;
const event = {
  receivingPhoneNumberId: '123456789',
  senderId: 'Sender:Á🙂',
  messageId: 'wamid:MiXeD:é🙂',
};
const at = '2026-06-22T01:02:03.004Z';
const bound = (
  coordinates = event,
  seconds = '1782086400',
  observedAt = at,
) => {
  const evidence = bindRestockInboundEvidence(
    { event: coordinates, providerTimestampSeconds: seconds, observedAt },
    coordinates.receivingPhoneNumberId,
  );
  if (!evidence) throw new Error('invalid domain fixture');
  return evidence;
};
const fixture = (...args: Parameters<typeof bound>): Row => {
  const value = bound(...args);
  return {
    source_request_id: value.sourceRequestId,
    receiving_phone_number_id: value.receivingPhoneNumberId,
    sender_id: value.senderId,
    message_id: value.messageId,
    provider_timestamp_seconds: value.providerTimestampSeconds,
    observed_at: value.observedAt,
    version: value.version,
  };
};

ddescribe('restock inbound evidence migration (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool;
  let uri: string;
  const migrate = (direction: 'up' | 'down') => {
    try {
      execFileSync(
        process.execPath,
        [
          BIN,
          '--config-file',
          'package.json',
          '--config-value',
          'pg-migrate',
          direction,
          ...(direction === 'up' ? ['2600000000000', '--timestamp'] : []),
        ],
        { cwd: ROOT, env: { DATABASE_URL: uri }, stdio: 'pipe' },
      );
    } catch (error) {
      // Never expose child output/URI in a Jest failure, even on failed setup.
      const output = error as { stdout?: Buffer; stderr?: Buffer };
      const guarded =
        `${String(output.stdout ?? '')}${String(output.stderr ?? '')}`.includes(
          `refusing to roll back ${TABLE}: table is non-empty`,
        );
      throw new Error(
        guarded ? 'nonempty rollback refused' : 'migration failed',
      );
    }
  };
  const insert = (patch: Partial<Row> = {}) => {
    const row = { ...fixture(), ...patch };
    return pool.query(
      `INSERT INTO ${TABLE} (${columns.join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      columns.map((column) => row[column]),
    );
  };
  const rejected = (column: Column, value: Row[Column], check: string) =>
    expect(insert({ [column]: value })).rejects.toMatchObject({
      code: '23514',
      constraint: `${TABLE}_${check}_check`,
    });
  const readRows = async () =>
    (await pool.query<Row>(`SELECT * FROM ${TABLE}`)).rows;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    migrate('up');
    pool = new Pool({ connectionString: uri });
  });
  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${TABLE}`);
  });

  it.each(columns)('rejects SQL NULL in %s independently', async (column) => {
    await expect(insert({ [column]: null })).rejects.toMatchObject({
      code: '23502',
      table: TABLE,
      column,
    });
  });

  it('has no column defaults and cannot synthesize observedAt', async () => {
    const schema = await pool.query<{
      column_name: string;
      column_default: string | null;
    }>(
      `SELECT column_name, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE],
    );
    expect(schema.rows).toHaveLength(7);
    expect(schema.rows.every((row) => row.column_default === null)).toBe(true);
    const included = columns.filter((column) => column !== 'observed_at');
    const row = fixture();
    await expect(
      pool.query(
        `INSERT INTO ${TABLE} (${included.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6)`,
        included.map((column) => row[column]),
      ),
    ).rejects.toMatchObject({ code: '23502', column: 'observed_at' });
  });

  it.each([0, 2, -1])('rejects version %s', async (version) => {
    await rejected('version', version, 'version');
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
    'checks %s bounds, blanks and outer spaces',
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

  it.each([
    '0',
    '01',
    '+1',
    '-1',
    '1e3',
    '1.5',
    '',
    '1\n',
    '9007199254740992',
    '8640000000001',
    '9'.repeat(1000),
  ])(
    'rejects raw seconds %j with CHECK, never cast failure',
    async (seconds) => {
      await rejected('provider_timestamp_seconds', seconds, 'provider_seconds');
    },
  );

  it.each([
    '',
    ' ',
    '2026-06-22T01:02:03.004+00:00',
    '2026-06-22T01:02:03Z',
    `${at}\n`,
  ])('rejects observedAt shape %j', async (observedAt) => {
    await rejected('observed_at', observedAt, 'observed_at');
  });

  it('roundtrips domain-bound Unicode/case coordinates and original time bytes', async () => {
    await insert();
    expect(await readRows()).toEqual([fixture()]);
  });

  it.each([
    ['1', '1', '1970-01-01T00:00:01.000Z'],
    ['9'.repeat(24), '8640000000000', '+275760-09-13T00:00:00.000Z'],
  ])(
    'accepts domain-valid phone/seconds/date boundaries %s',
    async (phone, seconds, date) => {
      const row = fixture(
        {
          receivingPhoneNumberId: phone,
          senderId: 's'.repeat(200),
          messageId: 'm'.repeat(512),
        },
        seconds,
        date,
      );
      await insert(row);
      expect(await readRows()).toEqual([row]);
    },
  );

  it('enforces UUID semantic case PK with actual alphabetic hex', async () => {
    const source = bound().sourceRequestId;
    expect(source.toUpperCase()).not.toBe(source);
    await insert();
    await expect(
      insert({ source_request_id: source.toUpperCase() }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: `${TABLE}_pkey`,
    });
  });

  it('enforces exact event uniqueness even with a corrupt different source UUID', async () => {
    await insert();
    // Deliberately not domain-reachable: isolate the DB tuple unique constraint.
    const corruptSource = 'aaaaaaaa-1111-4111-8111-111111111111';
    expect(corruptSource).not.toBe(bound().sourceRequestId);
    await expect(
      insert({ source_request_id: corruptSource }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: `${TABLE}_event_unique`,
    });
  });

  it('keeps distinct channels, case-sensitive senders and messages without normalization', async () => {
    const rows = [
      fixture(),
      fixture({ ...event, receivingPhoneNumberId: '987654321' }),
      fixture({ ...event, senderId: event.senderId.toLowerCase() }),
      fixture({ ...event, messageId: event.messageId.toLowerCase() }),
    ];
    for (const row of rows) await insert(row);
    expect(await readRows()).toEqual(expect.arrayContaining(rows));
    expect(await readRows()).toHaveLength(4);
  });

  it('documents structural SQL boundaries, not calendar/order/derived UUID validation', async () => {
    const candidates = [
      { ...bound(), observedAt: '2026-99-99T99:99:99.999Z' },
      { ...bound(), observedAt: '1970-01-01T00:00:01.000Z' },
      { ...bound(), sourceRequestId: 'aaaaaaaa-1111-4111-8111-111111111111' },
    ];
    for (const candidate of candidates) {
      expect(normalizeRestockInboundEvidence(candidate)).toBeNull();
      await insert({
        source_request_id: candidate.sourceRequestId,
        observed_at: candidate.observedAt,
      });
      expect(await readRows()).toEqual([
        {
          ...fixture(),
          source_request_id: candidate.sourceRequestId,
          observed_at: candidate.observedAt,
        },
      ]);
      await pool.query(`TRUNCATE TABLE ${TABLE}`);
    }
  });

  it('refuses down for one valid row, drops only when empty, and reapplies 260', async () => {
    await insert();
    expect(() => migrate('down')).toThrow('nonempty rollback refused');
    expect(await readRows()).toEqual([fixture()]);
    // The failed transactional rollback preserves constraints as well as data.
    await rejected('version', 2, 'version');
    await pool.query(`TRUNCATE TABLE ${TABLE}`);
    try {
      migrate('down');
      const absent = await pool.query('SELECT to_regclass($1) AS name', [
        TABLE,
      ]);
      expect(absent.rows).toEqual([{ name: null }]);
    } finally {
      migrate('up');
    }
    expect(await readRows()).toEqual([]);
    await insert();
    expect(await readRows()).toEqual([fixture()]);
    await rejected('version', 2, 'version');
  });
});
