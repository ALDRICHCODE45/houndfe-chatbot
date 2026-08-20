import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { AppConfigModule } from '../config/config.module';
import { DatabaseModule } from './database.module';
import { PG_POOL, PostgresPoolLifecycle } from './postgres-pool.provider';

/**
 * Integration tests for DatabaseModule.
 *
 * Spec scenarios covered (gated by RUN_DOCKER_TESTS):
 *   - 6.3: app.close() (shutdown) triggers OnModuleDestroy → pool.end()
 *   - Pool builds from real DATABASE_URL + DB_POOL_MAX
 *
 * Without Docker (default), the suite runs unit-only: provider wiring
 * is exercised through a stub ConfigService. The Testcontainers pass
 * proves end-to-end wiring against a real postgres:16-alpine container.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

describe('DatabaseModule unit wiring', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const MANAGED_KEYS = [
    'DATABASE_URL',
    'DB_POOL_MAX',
    'META_VERIFY_TOKEN',
    'META_APP_SECRET',
    'META_ACCESS_TOKEN',
    'META_PHONE_NUMBER_ID',
    'CHATBOT_API_BASE_URL',
    'SERVICE_KEY',
    'CHATBOT_API_BRANCH_ID',
    'OPENAI_API_KEY',
    'LLM_MODEL',
  ];

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
    }
    Object.assign(process.env, {
      META_VERIFY_TOKEN: 't',
      META_APP_SECRET: 's',
      META_ACCESS_TOKEN: 'a',
      META_PHONE_NUMBER_ID: '1',
      CHATBOT_API_BASE_URL: 'https://x.example.com',
      SERVICE_KEY: 'svc_x',
      CHATBOT_API_BRANCH_ID: 'b',
      OPENAI_API_KEY: 'g',
      LLM_MODEL: 'm',
      DATABASE_URL: 'postgres://u:p@localhost:5432/d',
      DB_POOL_MAX: '3',
    });
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
  });

  it('provides PG_POOL and PostgresPoolLifecycle through the module', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), DatabaseModule],
    }).compile();

    const pool = moduleRef.get<Pool>(PG_POOL);
    expect(pool).toBeInstanceOf(Pool);
    const lifecycle = moduleRef.get(PostgresPoolLifecycle);
    expect(lifecycle).toBeInstanceOf(PostgresPoolLifecycle);

    const endSpy = jest.spyOn(pool, 'end').mockResolvedValue(undefined);

    await moduleRef.close();
    // Shutdown runs OnModuleDestroy → pool.end()
    expect(endSpy).toHaveBeenCalled();
  });
});

ddescribe('DatabaseModule integration (Testcontainers)', () => {
  jest.setTimeout(60_000);
  let container: StartedPostgreSqlContainer;
  let moduleRef: Awaited<ReturnType<typeof Test.createTestingModule['prototype']['compile']>>;
  let pool: Pool;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const REQUIRED: Record<string, string> = {
      META_VERIFY_TOKEN: 'stub-verify',
      META_APP_SECRET: 'stub-secret',
      META_ACCESS_TOKEN: 'stub-access',
      META_PHONE_NUMBER_ID: '1234567890',
      CHATBOT_API_BASE_URL: 'https://api.example.com',
      SERVICE_KEY: 'svc_stub',
      CHATBOT_API_BRANCH_ID: 'stub-branch',
      OPENAI_API_KEY: 'stub-openai',
      LLM_MODEL: 'anthropic/claude-sonnet-4.5',
    };
    for (const [key, fallback] of Object.entries(REQUIRED)) {
      savedEnv[key] = process.env[key];
      process.env[key] = process.env[key] ?? fallback;
    }

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DB_POOL_MAX = '4';

    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), DatabaseModule],
    }).compile();

    pool = moduleRef.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    if (container) {
      await container.stop();
    }
    for (const [key, saved] of Object.entries(savedEnv)) {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
    delete process.env.DATABASE_URL;
    delete process.env.DB_POOL_MAX;
  });

  it('opens a real pool against the container and closes it on shutdown', async () => {
    expect(pool).toBeInstanceOf(Pool);

    // sanity: a real round-trip query succeeds.
    const result = await pool.query('SELECT 1 AS one');
    expect(result.rows[0].one).toBe(1);

    // moduleRef.close() in afterAll triggers OnModuleDestroy → pool.end().
    // We just assert the pool is usable here; the close path is the
    // unit-level assertion above.
  });
});