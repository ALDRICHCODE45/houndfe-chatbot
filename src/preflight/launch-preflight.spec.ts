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
  it.each(['true', 'false', undefined])(
    'U6: does not check the removed shipping postures (%s)',
    (value) => {
      const env = safeEnv();
      env.SHIPPING_QUOTES_ENABLED = value;
      env.MINIMAL_CATALOG_SHIPPING_ENABLED = value;
      const report = run(env);
      expect(report.ok).toBe(true);
      expect(
        report.posture.filter((c: { name: string }) => /SHIPPING/.test(c.name)),
      ).toEqual([]);
    },
  );
  it('S2: does not check the removed atomic checkout posture', () => {
    const env = safeEnv();
    delete env.MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED;
    const report = run(env);
    expect(report.ok).toBe(true);
    expect(
      report.posture.some(
        (c: { name: string }) =>
          c.name === 'MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED',
      ),
    ).toBe(false);
  });
  it('S2: lists the atomic checkout routes the order flow calls', () => {
    expect(run(safeEnv()).clientRoutes).toEqual(
      expect.arrayContaining([
        {
          method: 'POST',
          path: '/chatbot-api/checkouts',
          scope: 'customers:write sales:create',
          status: 'manual_external',
        },
        {
          method: 'GET',
          path: '/chatbot-api/checkouts/status',
          scope: 'customers:write sales:create',
          status: 'manual_external',
        },
      ]),
    );
  });
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
    delete missing.META_SANDBOX_RECIPIENT_NORMALIZATION;
    const nonExact = safeEnv();
    nonExact.META_SANDBOX_RECIPIENT_NORMALIZATION = 'FALSE';
    const wrong = safeEnv();
    wrong.META_SANDBOX_RECIPIENT_NORMALIZATION = 'true';

    expect(run(missing).ok).toBe(false);
    expect(run(nonExact).ok).toBe(false);
    expect(run(wrong).ok).toBe(false);
    expect(
      run(missing).posture.find(
        (c: { name: string }) =>
          c.name === 'META_SANDBOX_RECIPIENT_NORMALIZATION',
      )?.status,
    ).toBe('missing');
    expect(
      run(nonExact).posture.find(
        (c: { name: string }) =>
          c.name === 'META_SANDBOX_RECIPIENT_NORMALIZATION',
      )?.status,
    ).toBe('unsafe');
    expect(
      run(missing).failures.some((f: { area: string }) => f.area === 'posture'),
    ).toBe(true);
  });

  // R3/S7: receipt media is always on; its removed flags are not checked.
  it.each(['RECEIPT_MEDIA_ENABLED', 'RECEIPT_MEDIA_INGESTION_ENABLED'])(
    'does not check the removed %s posture',
    (name) => {
      const env = safeEnv();
      env[name] = 'true';
      const report = run(env);
      expect(report.ok).toBe(true);
      expect(
        report.posture.some((c: { name: string }) => c.name === name),
      ).toBe(false);
    },
  );

  it('lists the receipt upload and outcome routes with their scopes', () => {
    expect(run(safeEnv()).clientRoutes).toEqual(
      expect.arrayContaining([
        {
          method: 'POST',
          path: '/chatbot-api/sales/:saleId/receipts',
          scope: 'sales:write',
          status: 'manual_external',
        },
        {
          method: 'GET',
          path: '/chatbot-api/receipts/:receiptId',
          scope: 'sales:read',
          status: 'manual_external',
        },
      ]),
    );
  });

  it('requires the receipt payment flow migrations', () => {
    expect(REQUIRED_MIGRATIONS).toEqual(
      expect.arrayContaining([
        '3300000000000_receipt_media_backend_upload.js',
        '3400000000000_receipt_media_outcome.js',
        '3500000000000_receipt_media_backend_only.js',
        '3600000000000_receipt_media_upload_fields.js',
      ]),
    );
  });

  it('requires the customer profile migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain('3700000000000_customer_profiles.js');
  });

  it('requires the transcript and backend outbox migrations', () => {
    expect(REQUIRED_MIGRATIONS).toEqual(
      expect.arrayContaining([
        '3800000000000_conversation_transcript.js',
        '3900000000000_backend_outbox.js',
      ]),
    );
  });

  it('requires the durable conversation gates migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain(
      '4200000000000_conversation_gates.js',
    );
  });

  it('requires the per-topic human reservation migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain(
      '4000000000000_human_decision_reservations_per_topic.js',
    );
  });

  it('requires the human request feed migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain(
      '4300000000000_human_request_feed.js',
    );
  });

  it('requires the backend outbox lanes migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain(
      '4400000000000_backend_outbox_lanes.js',
    );
  });

  it('requires the human request feed retention migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain(
      '4500000000000_human_request_feed_retention.js',
    );
  });

  it('requires the webhook dedup claims migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain(
      '4100000000000_processed_webhook_messages_claims.js',
    );
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

  it('does not check the removed HUMAN_HANDOFF_ENABLED posture', () => {
    const env = safeEnv();
    delete env.HUMAN_HANDOFF_ENABLED;
    const report = run(env);
    expect(report.ok).toBe(true);
    expect(
      report.posture.some(
        (c: { name: string }) => c.name === 'HUMAN_HANDOFF_ENABLED',
      ),
    ).toBe(false);
  });

  it('requires the DELIVERY_ZONE requester migration', () => {
    expect(REQUIRED_MIGRATIONS).toContain(
      '3200000000000_delivery_zone_requesters.js',
    );
  });

  it('fails when a human-decision migration is absent from disk', () => {
    const name = '3100000000000_customer_inbound_observations.js';
    const report = run(
      safeEnv(),
      REQUIRED_MIGRATIONS.filter((m: string) => m !== name),
    );
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual({
      area: 'migration',
      name,
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
    expect(first.clientRoutes).toHaveLength(18);
    expect(CLIENT_ROUTES).toEqual(
      expect.arrayContaining([
        ['POST', '/chatbot-api/human-decisions', 'human-decisions:create'],
        ['GET', '/chatbot-api/human-decisions/:id', 'human-decisions:read'],
        [
          'POST',
          '/chatbot-api/human-decisions/:id/application-outcome',
          'human-decisions:ack',
        ],
      ]),
    );
    expect(first.manualChecks.map((c: { id: string }) => c.id)).toEqual([
      'backend_reachable',
      'bot_cashier_user',
      'service_credential',
      'active_payment_detail',
      'populated_catalog',
      'backend_shipping_quotes',
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

describe('shipping launch preflight', () => {
  it('lists the backend shipping quote route with the shipping:quote scope', () => {
    expect(run(safeEnv()).clientRoutes).toContainEqual({
      method: 'POST',
      path: '/chatbot-api/shipping/quotes',
      scope: 'shipping:quote',
      status: 'manual_external',
    });
  });

  it('never leaks removed Skydropx values into the report', () => {
    const env = safeEnv();
    env.SKYDROPX_CLIENT_SECRET = `sk_${CANARY}`;
    env.SKYDROPX_BASE_URL = `https://sandbox.example/${CANARY}`;
    const serialized = JSON.stringify(run(env));
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain('sk_');
    expect(serialized).not.toContain('sandbox.example');
    expect(serialized).not.toMatch(/skydropx/i);
  });
});
