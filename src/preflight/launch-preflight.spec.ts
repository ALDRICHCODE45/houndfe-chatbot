import {
  CLIENT_ROUTES,
  CORE_CONFIG_NAMES,
  POSTURE_EXPECTATIONS,
  REQUIRED_MIGRATIONS,
  runLaunchPreflight,
} from './launch-preflight';

// MVP-3 offline no-secret preflight tests: verdicts plus no-value-leak proof.
type Env = Record<string, string | undefined>;
const CANARY = 'CANARY_9f3c_do_not_emit_7bf1';

const safeEnv = (): Env => {
  const env: Env = {};
  for (const name of CORE_CONFIG_NAMES) env[name] = `${CANARY}_value`;
  for (const { name, expected } of POSTURE_EXPECTATIONS) env[name] = expected;
  return env;
};

const run = (
  env: Env,
  migrationFilenames: readonly string[] = REQUIRED_MIGRATIONS,
) => runLaunchPreflight({ env, migrationFilenames });

describe('runLaunchPreflight', () => {
  it('passes the happy path with every automatic check satisfied', () => {
    const report = run(safeEnv());
    expect(report.schemaVersion).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.coreConfig).toHaveLength(CORE_CONFIG_NAMES.length);
    expect(
      report.coreConfig.every(
        (c: { status: string }) => c.status === 'present',
      ),
    ).toBe(true);
    expect(
      report.posture.every((c: { status: string }) => c.status === 'safe'),
    ).toBe(true);
    expect(
      report.migrations.every(
        (c: { status: string }) => c.status === 'present_on_disk',
      ),
    ).toBe(true);
  });

  it('fails when a core config name is missing or blank', () => {
    const absent = safeEnv();
    delete absent.META_APP_SECRET;
    const blank = safeEnv();
    blank.SERVICE_KEY = '';

    expect(run(absent).ok).toBe(false);
    expect(run(blank).ok).toBe(false);
    expect(
      run(absent).coreConfig.find(
        (c: { name: string }) => c.name === 'META_APP_SECRET',
      )?.status,
    ).toBe('missing');
    expect(
      run(blank).coreConfig.find(
        (c: { name: string }) => c.name === 'SERVICE_KEY',
      )?.status,
    ).toBe('missing');
    expect(run(absent).failures).toContainEqual({
      area: 'core_config',
      name: 'META_APP_SECRET',
      status: 'missing',
    });
  });

  it('fails closed on missing posture and rejects non-exact values', () => {
    const missing = safeEnv();
    delete missing.RECEIPT_MEDIA_INGESTION_ENABLED;
    const nonExact = safeEnv();
    nonExact.HUMAN_HANDOFF_ENABLED = 'TRUE';
    const wrong = safeEnv();
    wrong.RECEIPT_MEDIA_ENABLED = 'true';

    expect(run(missing).ok).toBe(false);
    expect(run(nonExact).ok).toBe(false);
    expect(run(wrong).ok).toBe(false);
    expect(
      run(missing).posture.find(
        (c: { name: string }) => c.name === 'RECEIPT_MEDIA_INGESTION_ENABLED',
      )?.status,
    ).toBe('missing');
    expect(
      run(nonExact).posture.find(
        (c: { name: string }) => c.name === 'HUMAN_HANDOFF_ENABLED',
      )?.status,
    ).toBe('unsafe');
    expect(
      run(missing).failures.some((f: { area: string }) => f.area === 'posture'),
    ).toBe(true);
  });

  it('fails when a required migration filename is absent from disk', () => {
    const withoutOne = REQUIRED_MIGRATIONS.filter(
      (name: string) => name !== '2000000000000_receipt_media.js',
    );

    const report = run(safeEnv(), withoutOne);
    expect(report.ok).toBe(false);
    expect(
      report.migrations.find(
        (m: { name: string }) => m.name === '2000000000000_receipt_media.js',
      )?.status,
    ).toBe('missing_on_disk');
    expect(report.failures).toContainEqual({
      area: 'migration',
      name: '2000000000000_receipt_media.js',
      status: 'missing_on_disk',
    });
  });

  it('is deterministic and lists manual checks without verifying them', () => {
    const first = run(safeEnv());
    expect(run(safeEnv())).toEqual(first);
    expect(first.clientRoutes).toEqual(
      CLIENT_ROUTES.map(
        ([method, path, scope]: readonly [string, string, string]) => ({
          method,
          path,
          scope,
          status: 'manual_external',
        }),
      ),
    );
    expect(first.clientRoutes).toHaveLength(11);
    expect(first.manualChecks.map((c: { id: string }) => c.id)).toEqual([
      'backend_reachable',
      'bot_cashier_user',
      'service_credential',
      'active_payment_detail',
      'populated_catalog',
    ]);
    expect(
      first.manualChecks.every(
        (c: { status: string }) => c.status === 'manual_external',
      ),
    ).toBe(true);
    expect(first.ok).toBe(true);
  });

  it('never leaks env values or secrets into the serialized report', () => {
    const env = safeEnv();
    env.SERVICE_KEY = `svc_${CANARY}`;
    env.META_APP_SECRET = CANARY;
    env.DATABASE_URL = `postgres://user:${CANARY}@db/internal`;

    const report = run(env);
    for (const serialized of [
      JSON.stringify(report),
      JSON.stringify(report, null, 2),
    ]) {
      expect(serialized).not.toContain(CANARY);
      expect(serialized).not.toContain('svc_');
      expect(serialized).not.toContain('postgres://');
      expect(serialized).not.toContain('internal');
    }
    const allowed = new Set([
      'present',
      'missing',
      'safe',
      'unsafe',
      'present_on_disk',
      'missing_on_disk',
      'manual_external',
    ]);
    const statuses = [
      ...report.coreConfig,
      ...report.posture,
      ...report.migrations,
      ...report.clientRoutes,
      ...report.manualChecks,
    ].map((c: { status: string }) => c.status);
    expect(statuses.every((s) => allowed.has(s))).toBe(true);
  });
});
