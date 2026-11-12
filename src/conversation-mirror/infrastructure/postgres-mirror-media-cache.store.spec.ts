import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { runMirrorMediaCacheStoreContract } from './mirror-media-cache.store.contract';
import { PostgresMirrorMediaCacheStore } from './postgres-mirror-media-cache.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const MIGRATION = '4800000000000';
const KEY = '8b1f0d3e-4c52-5a91-9e0a-1f2e3d4c5b6a';

ddescribe('mirror_media_cache (real PostgreSQL)', () => {
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
      { cwd: ROOT, env: { DATABASE_URL: uri }, stdio: 'pipe', timeout: 60_000 },
    );
  const tableExists = async () =>
    (
      await pool.query<{ present: boolean }>(
        "SELECT to_regclass('public.mirror_media_cache') IS NOT NULL AS present",
      )
    ).rows[0].present;
  const insert = (over: Partial<Record<string, unknown>> = {}) => {
    const row = {
      idempotency_key: KEY,
      media_id: '0b3f1c1e-8a53-4d6f-9c1b-2a4e5f6a7b8c',
      mime_type: 'image/jpeg',
      size_bytes: 1000,
      ...over,
    };
    return pool.query(
      `INSERT INTO mirror_media_cache (idempotency_key, media_id, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4)`,
      [row.idempotency_key, row.media_id, row.mime_type, row.size_bytes],
    );
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    migrate('up');
    pool = new Pool({ connectionString: uri });
  });
  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('migration', () => {
    afterEach(async () => {
      await pool.query('TRUNCATE TABLE mirror_media_cache');
    });

    it('creates the table with the specified columns, defaults and key', async () => {
      const { rows } = await pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'mirror_media_cache' ORDER BY ordinal_position`,
      );
      expect(rows).toEqual([
        {
          column_name: 'idempotency_key',
          data_type: 'uuid',
          is_nullable: 'NO',
        },
        { column_name: 'media_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'mime_type', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'size_bytes', data_type: 'bigint', is_nullable: 'NO' },
        {
          column_name: 'created_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'NO',
        },
        {
          column_name: 'last_used_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'NO',
        },
      ]);
      await insert();
      const { rows: stored } = await pool.query<{
        created_at: Date;
        last_used_at: Date;
      }>('SELECT created_at, last_used_at FROM mirror_media_cache');
      expect(stored[0].created_at).toBeInstanceOf(Date);
      expect(stored[0].last_used_at).toBeInstanceOf(Date);
      await expect(insert()).rejects.toMatchObject({ code: '23505' });
    });

    it.each([
      ['empty media id', { media_id: '' }, 'media_id'],
      ['oversized media id', { media_id: 'x'.repeat(101) }, 'media_id'],
      ['empty mime', { mime_type: '' }, 'mime_type'],
      ['zero size', { size_bytes: 0 }, 'size_bytes'],
      ['over 10 MiB', { size_bytes: 10 * 1024 * 1024 + 1 }, 'size_bytes'],
    ])('rejects %s', async (_name, over, check) => {
      await expect(insert(over)).rejects.toMatchObject({
        code: '23514',
        constraint: `mirror_media_cache_${check}_check`,
      });
    });

    it('rejects a key that is not a uuid', async () => {
      await expect(
        insert({ idempotency_key: 'not-a-uuid' }),
      ).rejects.toMatchObject({ code: '22P02' });
    });

    it('has the recency index used by the prune', async () => {
      const { rows } = await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'mirror_media_cache'",
      );
      expect(rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining(['mirror_media_cache_last_used_idx']),
      );
    });

    it('down refuses while cache rows exist, then drops the empty table, and up recreates it', async () => {
      await insert();
      expect(() => migrate('down', '1')).toThrow();
      expect(await tableExists()).toBe(true);
      await pool.query('TRUNCATE TABLE mirror_media_cache');
      migrate('down', '1');
      expect(await tableExists()).toBe(false);
      migrate('up', MIGRATION, '--timestamp');
      expect(await tableExists()).toBe(true);
    });
  });

  runMirrorMediaCacheStoreContract('PostgresMirrorMediaCacheStore', () => ({
    store: new PostgresMirrorMediaCacheStore(pool),
    // Time passes for the rows already stored (the database owns `now()`).
    advance: async (ms: number) => {
      await pool.query(
        `UPDATE mirror_media_cache
              SET created_at = created_at - ($1 * interval '1 millisecond'),
                  last_used_at = last_used_at - ($1 * interval '1 millisecond')`,
        [ms],
      );
    },
    now: () => new Date(),
    cleanup: async () => {
      await pool.query('TRUNCATE TABLE mirror_media_cache');
    },
  }));
});
